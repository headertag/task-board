import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {mkdtemp,mkdir,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {deflateSync} from 'node:zlib';
import {BoardService} from '../lib/service.ts';
import {backupPage,migrationPage,validateBackup} from '../lib/backup.ts';
import {execute} from '../lib/operations.ts';
import {normalizePng,crc32} from '../lib/image.ts';
import {hash,stable,stableId} from '../lib/safety.ts';
import {recoverBackup} from '../scripts/recover-backup.mjs';
import {backupLocal,backupOptionsFromEnvironment} from '../scripts/backup-local.mjs';

// Fictional records, identities and credentials only. All HTTP remains loopback.
const owner='fictional-legacy-storage-owner';
function chunk(type,body){const out=new Uint8Array(body.length+12),view=new DataView(out.buffer);view.setUint32(0,body.length);out.set(new TextEncoder().encode(type),4);out.set(body,8);view.setUint32(out.length-4,crc32(out.subarray(4,out.length-4)));return out}
const header=new Uint8Array(13);new DataView(header.buffer).setUint32(0,1);new DataView(header.buffer).setUint32(4,1);header[8]=8;header[9]=6;
const image=(await normalizePng(Buffer.concat([Uint8Array.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Uint8Array.from([0,255,0,0,255]))),chunk('IEND',new Uint8Array())]))).bytes;
class Prepared{
 constructor(sql,q,args=[]){this.sql=sql;this.q=q;this.args=args}
 bind(...args){return new Prepared(this.sql,this.q,args)}
 async first(){return this.sql.prepare(this.q).get(...this.args)??null}
 async all(){return {results:this.sql.prepare(this.q).all(...this.args)}}
}
function database(sql){return {prepare:q=>new Prepared(sql,q),batch:async ps=>{sql.exec('BEGIN');try{const out=ps.map(p=>/^SELECT/i.test(p.q)?{results:sql.prepare(p.q).all(...p.args)}:sql.prepare(p.q).run(...p.args));sql.exec('COMMIT');return out}catch(e){sql.exec('ROLLBACK');throw e}}}}
function bucket(objects=new Map()){
 return {objects,puts:0,async put(key,bytes){this.puts++;objects.set(key,new Uint8Array(bytes));return {key}},async get(key,options){const bytes=objects.get(key);if(!bytes)return null;const part=options?.range?bytes.slice(options.range.offset,options.range.offset+options.range.length):bytes;return {arrayBuffer:async()=>part.buffer.slice(part.byteOffset,part.byteOffset+part.byteLength),body:new Blob([part]).stream()}}}
}
async function fixture(t){
 const sql=new DatabaseSync(':memory:');for(const file of readdirSync('drizzle').filter(f=>f.endsWith('.sql')).sort())sql.exec(readFileSync(path.join('drizzle',file),'utf8'));t.after(()=>sql.close());
 const db=database(sql),images=bucket(),service=new BoardService(db,owner,images);
 let task=await service.mutate('create',{task:{title:'Fictional migration record',sample:true},requestKey:'fixture-task-create'});
 task=await service.mutate('update',{id:task.id,expectedRevision:task.revision,patch:{nextAction:'Fictional second revision'},requestKey:'fixture-task-update'});
 const attached=await service.activity.upload(task.id,'fixture-upload-attached',image,'evidence.png');
 const retained=await service.activity.upload(task.id,'fixture-upload-retained',image,'retained-draft.png');
 let comment=await service.activity.mutate('add',{taskId:task.id,body:'Fictional comment',attachmentIds:[attached.id],requestKey:'fixture-comment-add'});
 comment=await service.activity.mutate('archive',{id:comment.id,expectedRevision:comment.revision,requestKey:'fixture-comment-remove'});
 task=await service.mutate('archive',{id:task.id,expectedRevision:task.revision,requestKey:'fixture-task-archive'});
 const source=await service.export();sql.prepare('INSERT INTO snapshots(owner,id,payload,created_at) VALUES(?,?,?,?)').run(owner,'source:fixture-import-key',JSON.stringify(source),source.exportedAt);
 return {sql,db,images,service,task,comment,attached,retained};
}
async function capture(f,version=3){const operation=version===3?migrationPage:backupPage,pages=[await operation(f.db,owner,f.images,null,1)];while(pages.at(-1).nextCursor)pages.push(await operation(f.db,owner,f.images,pages.at(-1).nextCursor,1));return pages}
async function area(t){const root=await mkdtemp(path.join(tmpdir(),'task-board-migration-test-'));t.after(()=>rm(root,{recursive:true,force:true}));return root}
async function rechain(pages){let previous=null;for(const p of pages){p.previousChecksum=previous;const {checksum,nextCursor,...body}=p;p.checksum=await hash(stable(body));previous=p.checksum}return pages}
async function addPending(f){const id=await stableId(`${owner}:upload:fixture-pending-upload`),a={...f.retained,id};f.sql.prepare('INSERT INTO attachments(owner,id,task_id,payload,object_key,request_key,fingerprint,ready,size) VALUES(?,?,?,?,?,?,?,?,?)').run(owner,id,a.taskId,JSON.stringify(a),`images/${await hash(owner)}/${id}`,'fixture-pending-upload',await hash(stable({taskId:a.taskId,digest:a.sha256,filename:a.filename})),0,a.size)}

test('v3 export and repeated recovery preserve exact records, retained images and original upload retries',async t=>{
 const f=await fixture(t),pages=await capture(f),verified=await validateBackup(pages);
 assert.equal(pages[0].version,3);assert.equal(pages[0].ownerTag,await hash(owner));assert.equal(pages[0].storageOwner,owner);assert.equal(pages[0].counts.uploadRetries,2);
 assert.deepEqual(verified.tasks,[f.task]);assert.deepEqual(verified.comments,[f.comment]);assert.equal(verified.snapshots[0].id,'source:fixture-import-key');assert.deepEqual(verified.blobs.get(f.retained.id),image);
 const root=await area(t),destination=path.join(root,'recovery'),out=await recoverBackup(pages,destination,owner);
 assert.equal((await recoverBackup(pages,destination,owner)).complete,true);
 const restoredSql=new DatabaseSync(out.database);t.after(()=>restoredSql.close());const restoredDb=database(restoredSql),restoredImages=bucket();
 for(const a of verified.attachments)restoredImages.objects.set(`images/${await hash(owner)}/${a.id}`,new Uint8Array(await readFile(path.join(out.objects,a.id+'.png'))));
 const restored=new BoardService(restoredDb,owner,restoredImages);
 for(const [a,key] of [[f.attached,'fixture-upload-attached'],[f.retained,'fixture-upload-retained']]){
  assert.deepEqual(await restored.activity.upload(f.task.id,key,image,a.filename),a);
  await assert.rejects(()=>restored.activity.upload(f.task.id,key,image,'changed.png'),e=>e.code==='idempotency_conflict');
 }
 assert.equal(restoredImages.puts,0);assert.equal(restoredSql.prepare('SELECT COUNT(*) AS n FROM attachments').get().n,2);
 const recaptured=await validateBackup(await capture({db:restoredDb,images:restoredImages}));
 for(const key of ['tasks','history','snapshots','comments','commentHistory','attachments','uploadRetries'])assert.deepEqual(recaptured[key],verified[key]);
 assert.deepEqual([...recaptured.blobs],[...verified.blobs]);
 restoredSql.prepare('UPDATE attachments SET fingerprint=? WHERE id=?').run('0'.repeat(64),f.attached.id);
 await assert.rejects(()=>recoverBackup(pages,destination,owner),/Recovered attachments differ/);
});

test('migration refuses incomplete reservations initially and during continuation; ordinary v2 remains available',async t=>{
 const f=await fixture(t),first=await migrationPage(f.db,owner,f.images,null,1);await addPending(f);
 await assert.rejects(()=>migrationPage(f.db,owner,f.images,null,1),e=>e.code==='migration_pending_uploads');
 await assert.rejects(()=>migrationPage(f.db,owner,f.images,first.nextCursor,1),e=>e.code==='migration_pending_uploads');
 const pages=await capture(f,2);assert.equal(pages[0].version,2);assert.equal(pages[0].ownerTag,undefined);assert.equal(pages[0].uploadRetries,undefined);assert.equal(pages[0].counts.uploadRetries,undefined);assert.equal((await validateBackup(pages)).attachments.length,2);
});

test('migration continuation refuses new source writes rather than silently omitting post-manifest work',async t=>{
 const f=await fixture(t),first=await migrationPage(f.db,owner,f.images,null,1);
 await f.service.mutate('restore',{id:f.task.id,expectedRevision:f.task.revision,requestKey:'fixture-post-capture-write'});
 await assert.rejects(()=>migrationPage(f.db,owner,f.images,first.nextCursor,1),e=>e.code==='migration_source_changed');
 assert.equal((await validateBackup(await capture(f))).tasks[0].archived,false);
});

test('signed cursors reject cross-format use, tampering and another owner',async t=>{
 const f=await fixture(t),v2=await backupPage(f.db,owner,f.images,null,1),v3=await migrationPage(f.db,owner,f.images,null,1);
 for(const run of [()=>backupPage(f.db,owner,f.images,v3.nextCursor,1),()=>migrationPage(f.db,owner,f.images,v2.nextCursor,1),()=>migrationPage(f.db,'fictional-other-owner',f.images,v3.nextCursor,1),()=>migrationPage(f.db,owner,f.images,v3.nextCursor.slice(0,-5)+'AAAAA',1)])await assert.rejects(run,e=>e.code==='invalid_cursor');
 const pages=await capture(f);pages[1].version=2;await rechain(pages);await assert.rejects(()=>validateBackup(pages),/mixed backup pages/);
});

test('v3 recovery requires the original storage owner and owner-derived upload IDs before any writes',async t=>{
 const f=await fixture(t),pages=await capture(f),root=await area(t),destination=path.join(root,'must-stay-absent');
 await assert.rejects(()=>recoverBackup(pages,destination,'fictional-new-owner'),/original storage owner/);await assert.rejects(()=>stat(destination),e=>e.code==='ENOENT');
 pages[0].uploadRetries[0].requestKey='fictional-substituted-key';await rechain(pages);
 await assert.rejects(()=>recoverBackup(pages,destination,owner),/original owner and request key/);await assert.rejects(()=>stat(destination),e=>e.code==='ENOENT');
});

test('validator rejects missing, duplicated or altered migration retry metadata even with recomputed checksums',async t=>{
 const f=await fixture(t),original=await capture(f);
 for(const change of [p=>delete p[0].uploadRetries,p=>p[0].uploadRetries.pop(),p=>p[0].uploadRetries[1]={...p[0].uploadRetries[0]},p=>p[0].uploadRetries[0].fingerprint='0'.repeat(64),p=>p[1].ownerTag='0'.repeat(64),p=>p[1].uploadRetries=[],p=>p[0].storageOwner='fictional-substituted-owner']){
  const pages=structuredClone(original);change(pages);await rechain(pages);await assert.rejects(()=>validateBackup(pages));
 }
});

test('migration capture rejects legacy v2 recovery retry substitutes and changed source retry state',async t=>{
 const f=await fixture(t),pages=await capture(f),root=await area(t),out=await recoverBackup(await capture(f,2),path.join(root,'v2'),owner),sql=new DatabaseSync(out.database);t.after(()=>sql.close());
 await assert.rejects(()=>migrationPage(database(sql),owner,f.images,null,1),e=>e.code==='migration_retry_state');
 let cursor=pages[0].nextCursor,page;
 do{page=await migrationPage(f.db,owner,f.images,cursor,1);cursor=page.nextCursor}while(JSON.parse(Buffer.from(cursor,'base64url').toString()).payload.phase!=='images');
 f.sql.prepare('UPDATE attachments SET fingerprint=? WHERE id=?').run('0'.repeat(64),pages[0].attachments[0].id);
 await assert.rejects(()=>migrationPage(f.db,owner,f.images,cursor,1),e=>e.code==='invalid_cursor');
});

test('the distinct operation is read-only and ordinary backup retains its v2 contract',async t=>{
 const f=await fixture(t),migration=await execute(f.service,'export_migration_page',{pageSize:1}),ordinary=await execute(f.service,'export_backup_page',{pageSize:1});
 assert.equal(migration.version,3);assert.equal(ordinary.version,2);assert.equal(ordinary.uploadRetries,undefined);
 assert.equal(backupOptionsFromEnvironment({}).mode,'backup');assert.equal(backupOptionsFromEnvironment({TASK_BOARD_BACKUP_MODE:'migration'}).mode,'migration');
});

test('local CLI migration mode requests v3 explicitly and refuses a v2 response',async t=>{
 const f=await fixture(t),root=await area(t),destination=path.join(root,'private-snapshots');await mkdir(destination,{mode:0o700});let respondWithV2=false;const requests=[];
 const http=createServer(async(req,res)=>{try{let text='';for await(const b of req)text+=b;const input=JSON.parse(text);requests.push(input);assert.equal(req.headers.authorization,'Bearer fictional-migration-token');const page=await (respondWithV2?backupPage:migrationPage)(f.db,owner,f.images,input.args.cursor??null,input.args.pageSize);res.end(JSON.stringify(page))}catch{res.writeHead(500);res.end('{}')}});
 http.listen(0,'127.0.0.1');await once(http,'listening');t.after(()=>new Promise(resolve=>{http.closeAllConnections();http.close(resolve)}));
 const options={mode:'migration',origin:`http://127.0.0.1:${http.address().port}`,allowHttpLoopback:true,destination,token:'fictional-migration-token',pageSize:1};
 const out=await backupLocal(options),file=JSON.parse(await readFile(out.filename,'utf8'));assert.equal(file.version,3);assert.ok(requests.every(r=>r.name==='export_migration_page'));assert.equal((await validateBackup(file.pages)).uploadRetries.length,2);assert.equal((await stat(out.filename)).mode&0o777,0o600);
 respondWithV2=true;await assert.rejects(()=>backupLocal(options),e=>e.code==='invalid_backup');assert.deepEqual(await readFile(out.filename,'utf8'),JSON.stringify(file));
 await assert.rejects(()=>backupLocal({...options,mode:'unsupported'}),e=>e.code==='configuration');
});
