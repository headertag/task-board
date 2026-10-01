import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,chmod} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {deflateSync} from 'node:zlib';
import {BoardService} from '../lib/service.ts';
import {backupPage,migrationPage,validateBackup} from '../lib/backup.ts';
import {normalizePng,crc32} from '../lib/image.ts';
import {hash,stable} from '../lib/safety.ts';
import {migrateCloudflare,cloudflareTransport,migrationOptionsFromEnvironment,MigrationError} from '../scripts/migrate-cloudflare.mjs';

// Every record and credential is fictional; the injected transport never reaches a network.
const owner='fictional-source-storage-owner',token='fictional-cloudflare-token';
const settings={accountId:'a'.repeat(32),databaseId:'11111111-2222-4333-8444-555555555555',databaseName:'task-board-db',bucketName:'task-board-images',origin:'https://task-board.fictional-owner.workers.dev',apiToken:token,approved:true};
function chunk(type,body){const out=new Uint8Array(body.length+12),v=new DataView(out.buffer);v.setUint32(0,body.length);out.set(new TextEncoder().encode(type),4);out.set(body,8);v.setUint32(out.length-4,crc32(out.subarray(4,out.length-4)));return out}
const header=new Uint8Array(13);new DataView(header.buffer).setUint32(0,1);new DataView(header.buffer).setUint32(4,1);header[8]=8;header[9]=6;
const image=(await normalizePng(Buffer.concat([Uint8Array.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Uint8Array.from([0,255,0,0,255]))),chunk('IEND',new Uint8Array())]))).bytes;
class Prepared{constructor(sql,q,args=[]){this.sql=sql;this.q=q;this.args=args}bind(...args){return new Prepared(this.sql,this.q,args)}async first(){return this.sql.prepare(this.q).get(...this.args)??null}async all(){return {results:this.sql.prepare(this.q).all(...this.args)}}}
function d1(sql){return {prepare:q=>new Prepared(sql,q),batch:async ps=>{sql.exec('BEGIN');try{const r=ps.map(p=>/^SELECT/i.test(p.q)?{results:sql.prepare(p.q).all(...p.args)}:sql.prepare(p.q).run(...p.args));sql.exec('COMMIT');return r}catch(e){sql.exec('ROLLBACK');throw e}}}}
function storage(objects=new Map()){return {objects,puts:0,async put(key,b){this.puts++;objects.set(key,new Uint8Array(b));return {key}},async get(key,o){const b=objects.get(key);if(!b)return null;const part=o?.range?b.slice(o.range.offset,o.range.offset+o.range.length):b;return {body:new Blob([part]).stream(),arrayBuffer:async()=>part.buffer.slice(part.byteOffset,part.byteOffset+part.byteLength)}}}}
function schema(t){const sql=new DatabaseSync(':memory:');for(const file of readdirSync('drizzle').filter(f=>f.endsWith('.sql')).sort())sql.exec(readFileSync(path.join('drizzle',file),'utf8'));t.after(()=>sql.close());return sql}
async function capture(db,images,version=3){const run=version===3?migrationPage:backupPage,pages=[await run(db,owner,images,null,20)];while(pages.at(-1).nextCursor)pages.push(await run(db,owner,images,pages.at(-1).nextCursor,20));return pages}
async function source(t){
 const sql=schema(t),db=d1(sql),images=storage(),service=new BoardService(db,owner,images);
 let task=await service.mutate('create',{task:{title:'Fictional exact migration',sample:true},requestKey:'fixture-task-create'});
 const attached=await service.activity.upload(task.id,'fixture-upload-attached',image,'attached.png'),retained=await service.activity.upload(task.id,'fixture-upload-retained',image,'retained.png');
 let comment=await service.activity.mutate('add',{taskId:task.id,body:'Fictional removed comment',attachmentIds:[attached.id],requestKey:'fixture-comment-add'});
 comment=await service.activity.mutate('archive',{id:comment.id,expectedRevision:comment.revision,requestKey:'fixture-comment-remove'});
 task=await service.mutate('archive',{id:task.id,expectedRevision:task.revision,requestKey:'fixture-task-archive'});
 const snapshot=await service.export();sql.prepare('INSERT INTO snapshots(owner,id,payload,created_at) VALUES(?,?,?,?)').run(owner,'source:fixture-import',JSON.stringify(snapshot),snapshot.exportedAt);
 return {sql,db,images,service,task,comment,attached,retained,pages:await capture(db,images)};
}
function destination(t){
 const sql=schema(t),objects=new Map(),requests=[],queries=[],state={readOnly:'true',managedPublic:false,customDomains:[],origin:settings.origin,subdomain:'fictional-owner',databaseId:settings.databaseId,boundId:settings.databaseId,bucket:settings.bucketName,boundBucket:settings.bucketName};
 const hooks={};
 async function fetcher(url,init={}){
  const uri=new URL(url),request={url:String(url),init};requests.push(request);
  assert.equal(uri.origin,'https://api.cloudflare.com');assert.equal(init.redirect,'manual');assert.equal(init.headers.Authorization,`Bearer ${token}`);
  if(hooks.response){const r=await hooks.response(request);if(r)return r}
  let result;
  if(uri.pathname.endsWith('/query')){
   const input=JSON.parse(init.body);queries.push(input);assert.ok(input.params.length<=90);
   const statement=sql.prepare(input.sql),rows=/^\s*SELECT/i.test(input.sql)?statement.all(...input.params):(statement.run(...input.params),[]);
   if(hooks.afterSql){const r=await hooks.afterSql(input);if(r)return r}
   result=[{success:true,results:rows}];
  }else if(uri.pathname.includes('/objects/')){
   const key=uri.pathname.split('/objects/')[1].split('/').map(decodeURIComponent).join('/');
   if(init.method==='PUT'){
    assert.equal(init.headers['If-None-Match'],'*');assert.equal(init.headers['cf-r2-data-catalog-check'],'true');assert.equal(init.headers['Content-Type'],'image/png');
    if(objects.has(key))return new Response(null,{status:412});objects.set(key,new Uint8Array(init.body));return new Response(null,{status:200});
   }
   return objects.has(key)?new Response(objects.get(key)):new Response(null,{status:404});
  }else if(uri.pathname.endsWith('/domains/managed'))result={enabled:state.managedPublic};
  else if(uri.pathname.endsWith('/domains/custom'))result={domains:state.customDomains};
  else if(uri.pathname.endsWith('/workers/subdomain'))result={subdomain:state.subdomain};
  else if(uri.pathname.endsWith('/workers/scripts/task-board/settings'))result={bindings:[{name:'DB',type:'d1',id:state.boundId},{name:'IMAGES',type:'r2_bucket',bucket_name:state.boundBucket},{name:'TASK_BOARD_ORIGIN',type:'plain_text',text:state.origin},{name:'TASK_BOARD_READ_ONLY',type:'plain_text',text:state.readOnly}]};
  else if(uri.pathname.endsWith(`/d1/database/${settings.databaseId}`))result={uuid:state.databaseId,name:settings.databaseName};
  else if(uri.pathname.endsWith(`/r2/buckets/${settings.bucketName}`))result={name:state.bucket};
  else throw new Error('Unexpected fictional transport route');
  return Response.json({success:true,result});
 }
 return {sql,objects,requests,queries,state,hooks,fetcher};
}
async function rechain(pages){let previous=null;for(const p of pages){p.previousChecksum=previous;const {checksum,nextCursor,...body}=p;p.checksum=await hash(stable(body));previous=p.checksum}return pages}
function run(f,d,overrides={}){return migrateCloudflare({...settings,pages:f.pages,...overrides},{fetch:d.fetcher})}
async function expectCode(run,code){await assert.rejects(run,e=>e instanceof MigrationError&&e.code===code&&!e.message.includes(token))}

test('actual SQL and R2 transport preserve every canonical record, removed comment, retained image and upload retry',async t=>{
 const f=await source(t),d=destination(t),other=new BoardService(d1(d.sql),'fictional-unrelated-owner',storage(d.objects));
 await other.mutate('create',{task:{title:'Fictional unrelated board',sample:true},requestKey:'unrelated-task-create'});
 const unrelated=d.sql.prepare('SELECT * FROM tasks WHERE owner=?').all('fictional-unrelated-owner');
 const out=await run(f,d);assert.equal(out.complete,true);assert.equal(out.readOnly,true);assert.equal(out.mcpUrl,settings.origin+'/mcp');
 assert.equal(d.sql.prepare('SELECT state FROM task_board_migration_state WHERE owner=?').get(owner).state,'complete');
 assert.deepEqual(d.sql.prepare('SELECT * FROM tasks WHERE owner=?').all('fictional-unrelated-owner'),unrelated);
 const images=storage(d.objects),restored=new BoardService(d1(d.sql),owner,images),after=await validateBackup(await capture(d1(d.sql),images)),before=await validateBackup(f.pages);
 for(const k of ['tasks','history','snapshots','comments','commentHistory','attachments','uploadRetries'])assert.deepEqual(after[k],before[k]);assert.deepEqual([...after.blobs],[...before.blobs]);
 assert.deepEqual(await restored.activity.upload(f.task.id,'fixture-upload-attached',image,f.attached.filename),f.attached);assert.deepEqual(await restored.activity.upload(f.task.id,'fixture-upload-retained',image,f.retained.filename),f.retained);
 await assert.rejects(()=>restored.activity.upload(f.task.id,'fixture-upload-attached',image,'changed.png'),e=>e.code==='idempotency_conflict');assert.equal(images.puts,0);
 const puts=d.requests.filter(r=>r.init.method==='PUT').length,insertCount=d.queries.filter(q=>q.sql.startsWith('INSERT INTO tasks(')).length;
 assert.equal((await run(f,d)).complete,true);assert.equal(d.requests.filter(r=>r.init.method==='PUT').length,puts);assert.equal(d.queries.filter(q=>q.sql.startsWith('INSERT INTO tasks(')).length,insertCount);
});

test('an uncertain partial SQL failure resumes only the identical capture without duplicating records',async t=>{
 const f=await source(t),d=destination(t);let failed=false;
 d.hooks.afterSql=input=>{if(!failed&&input.sql.startsWith('INSERT INTO task_events(')){failed=true;return new Response('fictional unavailable',{status:503})}};
 await expectCode(()=>run(f,d),'remote_request');assert.equal(d.sql.prepare('SELECT state FROM task_board_migration_state WHERE owner=?').get(owner).state,'pending');assert.ok(d.sql.prepare('SELECT COUNT(*) AS n FROM task_events WHERE owner=?').get(owner).n>0);
 d.hooks.afterSql=undefined;assert.equal((await run(f,d)).complete,true);assert.equal(d.sql.prepare('SELECT COUNT(*) AS n FROM tasks WHERE owner=?').get(owner).n,1);
 const fresh=await capture(f.db,f.images);await expectCode(()=>run(f,d,{pages:fresh}),'different_migration');
});

test('a preexisting owner without this capture marker is refused without replacing records or uploading images',async t=>{
 const f=await source(t),d=destination(t),existing=new BoardService(d1(d.sql),owner,storage(d.objects));await existing.mutate('create',{task:{title:'Fictional existing owner record',sample:true},requestKey:'existing-owner-task'});
 const rows=d.sql.prepare('SELECT * FROM tasks WHERE owner=?').all(owner);await expectCode(()=>run(f,d),'destination_not_empty');assert.deepEqual(d.sql.prepare('SELECT * FROM tasks WHERE owner=?').all(owner),rows);assert.equal(d.objects.size,0);assert.equal(d.sql.prepare('SELECT COUNT(*) AS n FROM task_board_migration_state').get().n,0);
});

test('wrong owner, ordinary v2, invalid capture, substituted upload key or unapproved target fails before any remote calls',async t=>{
 const f=await source(t),d=destination(t),substituted=structuredClone(f.pages);substituted[0].uploadRetries[0].requestKey='fictional-substituted-key';await rechain(substituted);
 const broken=structuredClone(f.pages);broken[0].tasks[0].title='fictional corrupt checksum';
 for(const [options,code] of [[{owner:'fictional-new-owner'},'owner_mismatch'],[{pages:await capture(f.db,f.images,2)},'migration_capture_required'],[{pages:broken},'invalid_capture'],[{pages:substituted},'upload_identity_mismatch'],[{approved:false},'configuration'],[{databaseId:'-'.repeat(36)},'configuration'],[{origin:'https://task-board-oauth-staging.fictional-owner.workers.dev'},'configuration']])await expectCode(()=>run(f,d,options),code);
 assert.equal(d.requests.length,0);
});

test('a conflicting existing image is never overwritten and a failed precondition is verified rather than treated as success',async t=>{
 const f=await source(t),d=destination(t),a=f.pages[0].attachments[0],key=`images/${f.pages[0].ownerTag}/${a.id}`,conflict=new Uint8Array([1,2,3]);d.objects.set(key,conflict);
 await expectCode(()=>run(f,d),'destination_image_conflict');assert.deepEqual(d.objects.get(key),conflict);assert.equal(d.requests.filter(r=>r.init.method==='PUT').length,0);assert.equal(d.sql.prepare('SELECT COUNT(*) AS n FROM tasks WHERE owner=?').get(owner).n,0);
 const racing=destination(t);racing.hooks.response=request=>{if(request.init.method==='PUT'){const objectKey=new URL(request.url).pathname.split('/objects/')[1];racing.objects.set(objectKey,conflict);return new Response(null,{status:412})}};
 await expectCode(()=>run(f,racing),'destination_image_conflict');assert.deepEqual(racing.objects.get(key),conflict);
});

test('named Worker, account origin, exact D1/R2 and private domains must match before migration writes',async t=>{
 const f=await source(t);
 for(const override of [{readOnly:'false'},{managedPublic:true},{customDomains:[{enabled:true}]},{boundId:'22222222-2222-4222-8222-222222222222'},{databaseId:'22222222-2222-4222-8222-222222222222'},{bucket:'wrong-bucket'},{boundBucket:'wrong-bucket'},{origin:'https://task-board.another-owner.workers.dev'},{subdomain:'another-owner'}]){
  const d=destination(t);Object.assign(d.state,override);await expectCode(()=>run(f,d),'destination_not_frozen');assert.equal(d.queries.length,0);assert.equal(d.objects.size,0);
 }
});

test('a write-lock flip during transfer stops before the next write and leaves a resumable pending marker',async t=>{
 const f=await source(t),d=destination(t);let flipped=false;d.hooks.afterSql=input=>{if(!flipped&&input.sql.startsWith('INSERT INTO tasks(')){flipped=true;d.state.readOnly='false'}};
 await expectCode(()=>run(f,d),'destination_not_frozen');assert.equal(d.sql.prepare('SELECT state FROM task_board_migration_state WHERE owner=?').get(owner).state,'pending');assert.equal(d.sql.prepare('SELECT COUNT(*) AS n FROM task_events WHERE owner=?').get(owner).n,0);
 d.state.readOnly='true';d.hooks.afterSql=undefined;assert.equal((await run(f,d)).complete,true);
});

test('readback paginates all history and rejects changed completed records rather than repairing them silently',async t=>{
 const f=await source(t);let task=await f.service.mutate('restore',{id:f.task.id,expectedRevision:f.task.revision,requestKey:'fixture-task-restore'});
 for(let i=0;i<120;i++)task=await f.service.mutate('update',{id:task.id,expectedRevision:task.revision,patch:{nextAction:`Fictional revision ${i}`},requestKey:`fixture-history-${i}`});f.pages=await capture(f.db,f.images);
 const d=destination(t);await run(f,d);assert.equal(d.sql.prepare('SELECT COUNT(*) AS n FROM task_events WHERE owner=?').get(owner).n,123);assert.ok(d.queries.some(q=>q.sql.includes('FROM task_events WHERE owner=? AND rowid>?')&&q.params[1]>0));
 d.sql.prepare('UPDATE comments SET revision=revision+1 WHERE owner=?').run(owner);await expectCode(()=>run(f,d),'destination_record_conflict');
});

test('a changed migration marker cannot produce a success report',async t=>{
 const f=await source(t),d=destination(t);d.hooks.afterSql=input=>{if(input.sql.startsWith('UPDATE task_board_migration_state'))d.sql.prepare('UPDATE task_board_migration_state SET backup_digest=? WHERE owner=?').run('0'.repeat(64),owner)};
 await expectCode(()=>run(f,d),'different_migration');
});

test('same record values in a reordered history cannot pass exact migration verification',async t=>{
 const f=await source(t),d=destination(t);await run(f,d);
 const columns=['owner','request_key','fingerprint','task_id','action','before_json','after_json','created_at'],rows=d.sql.prepare(`SELECT ${columns.join(',')} FROM task_events WHERE owner=? ORDER BY rowid`).all(owner).reverse();
 d.sql.prepare('DELETE FROM task_events WHERE owner=?').run(owner);for(const row of rows)d.sql.prepare(`INSERT INTO task_events(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`).run(...columns.map(c=>row[c]));
 await expectCode(()=>run(f,d),'destination_history_conflict');
});

test('Cloudflare redirects, followed responses and PUT transport failures are refused without forwarding credentials',async()=>{
 const key='images/fictional-owner/fictional-id';
 for(const method of ['inspect','putObject'])for(const kind of ['redirect','followed','network']){
  const calls=[];const remote=cloudflareTransport(settings,async(url,init)=>{calls.push({url,init});if(kind==='network')throw new Error('fictional network failure containing '+token);if(kind==='redirect')return new Response(null,{status:307,headers:{Location:'https://fictional-redirect.invalid'}});const r=Response.json({success:true,result:{}});Object.defineProperty(r,'redirected',{value:true});return r});
  await expectCode(()=>method==='inspect'?remote.inspect():remote.putObject(key,image),kind==='network'?(method==='inspect'?'remote_request':'object_upload'):'remote_redirect');assert.equal(calls.length,1);assert.equal(calls[0].init.redirect,'manual');assert.equal(new URL(calls[0].url).origin,'https://api.cloudflare.com');
 }
});

test('CLI file inputs reject open files, ancestor symlinks, checkout/public paths and invalid JSON',async t=>{
 const f=await source(t),root=await mkdtemp(path.join(tmpdir(),'task-board-migration-files-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const captureFile=path.join(root,'capture.json'),tokenFile=path.join(root,'token');await writeFile(captureFile,JSON.stringify({format:'task-board-local-backup',version:3,pages:f.pages}),{mode:0o600});await writeFile(tokenFile,token+'\n',{mode:0o600});
 const env={TASK_BOARD_MIGRATION_FILE:captureFile,CLOUDFLARE_API_TOKEN_FILE:tokenFile,CLOUDFLARE_ACCOUNT_ID:settings.accountId,TASK_BOARD_D1_DATABASE_ID:settings.databaseId,TASK_BOARD_D1_DATABASE_NAME:settings.databaseName,TASK_BOARD_R2_BUCKET_NAME:settings.bucketName,TASK_BOARD_PRODUCTION_ORIGIN:settings.origin,TASK_BOARD_MIGRATION_APPROVED:'true'};
 const options=await migrationOptionsFromEnvironment(env);assert.equal(options.owner,undefined);assert.equal(options.apiToken,token);assert.deepEqual(options.pages,f.pages);
 await chmod(tokenFile,0o644);await expectCode(()=>migrationOptionsFromEnvironment(env),'private_file');await chmod(tokenFile,0o600);
 const ancestor=path.join(root,'linked');await symlink(root,ancestor);await expectCode(()=>migrationOptionsFromEnvironment({...env,TASK_BOARD_MIGRATION_FILE:path.join(ancestor,'capture.json')}),'private_file');
 for(const name of ['public','dist']){const folder=path.join(root,name);await mkdir(folder);await writeFile(path.join(folder,'capture.json'),await readFile(captureFile),{mode:0o600});await expectCode(()=>migrationOptionsFromEnvironment({...env,TASK_BOARD_MIGRATION_FILE:path.join(folder,'capture.json')}),'private_file')}
 const checkout=path.join(root,'checkout');await mkdir(path.join(checkout,'.git'),{recursive:true});await writeFile(path.join(checkout,'.git','HEAD'),'ref: refs/heads/main\n');await writeFile(path.join(checkout,'capture.json'),await readFile(captureFile),{mode:0o600});await expectCode(()=>migrationOptionsFromEnvironment({...env,TASK_BOARD_MIGRATION_FILE:path.join(checkout,'capture.json')}),'private_file');
 await expectCode(()=>migrationOptionsFromEnvironment({...env,CLOUDFLARE_API_TOKEN:token}),'credentials');await writeFile(captureFile,'invalid fictional JSON');await expectCode(()=>migrationOptionsFromEnvironment(env),'invalid_capture');
});
