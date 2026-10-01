import assert from 'node:assert/strict';
import {deflateSync} from 'node:zlib';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {normalizePng,crc32} from '../lib/image.ts';
import {BoardService} from '../lib/service.ts';
import {validateBackup} from '../lib/backup.ts';
import {hash,stable,base64} from '../lib/safety.ts';
const root=process.cwd(),results=[];
async function test(name,fn){try{await fn();results.push({name,result:'PASS'});console.log('PASS '+name)}catch(e){results.push({name,result:'FAIL',error:e.message,code:e.code});console.log('FAIL '+name+': '+e.message)}}
const sig=Uint8Array.from([137,80,78,71,13,10,26,10]);
function chunk(type,body){const out=new Uint8Array(body.length+12),v=new DataView(out.buffer);v.setUint32(0,body.length);out.set(new TextEncoder().encode(type),4);out.set(body,8);v.setUint32(out.length-4,crc32(out.subarray(4,out.length-4)));return out}
function cat(parts){const out=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let i=0;for(const p of parts){out.set(p,i);i+=p.length}return out}
function header(w=1,h=1,color=6){const a=new Uint8Array(13),v=new DataView(a.buffer);v.setUint32(0,w);v.setUint32(4,h);a[8]=8;a[9]=color;return chunk('IHDR',a)}
const IEND=chunk('IEND',new Uint8Array());
function png(raw=Uint8Array.from([0,255,0,0,255]),options={}){return cat([sig,header(options.w??1,options.h??1,options.color??6),...(options.pre??[]),chunk('IDAT',options.compressed??deflateSync(raw)),...(options.post??[]),IEND])}
const good=png();
await test('valid RGBA normalization and deterministic retry',async()=>{const a=await normalizePng(good);assert.equal(a.width,1);assert.deepEqual((await normalizePng(a.bytes)).bytes,a.bytes)});
await test('valid RGB and all scanline filters',async()=>{for(let f=0;f<5;f++)await normalizePng(png(Uint8Array.from([f,1,2,3]),{color:2}))});
await test('metadata removed without inflating iCCP',async()=>{const a=await normalizePng(png(undefined,{pre:[chunk('tEXt',new TextEncoder().encode('name\0secret')),chunk('iCCP',new Uint8Array([1,2,3]))]}));assert.deepEqual(a.bytes,(await normalizePng(good)).bytes)});
await test('CRC mismatch rejected',()=>assert.rejects(()=>{const bad=good.slice();bad[30]^=1;return normalizePng(bad)}));
await test('invalid row filter rejected',()=>assert.rejects(()=>normalizePng(png(Uint8Array.from([5,1,2,3,4])))));
await test('short and excessive scanline bytes rejected',async()=>{for(const n of [0,4,6,10])await assert.rejects(()=>normalizePng(png(new Uint8Array(n))))});
await test('truncated and trailing zlib input rejected',async()=>{const z=new Uint8Array(deflateSync(new Uint8Array(5)));await assert.rejects(()=>normalizePng(png(undefined,{compressed:z.subarray(0,z.length-1)})));await assert.rejects(()=>normalizePng(png(undefined,{compressed:cat([z,new Uint8Array([1])])}))) });
await test('APNG unknown critical duplicate IHDR trailing PNG rejected',async()=>{for(const type of ['acTL','fcTL','fdAT','ABCD','IHDR'])await assert.rejects(()=>normalizePng(png(undefined,{pre:[chunk(type,new Uint8Array())]})));await assert.rejects(()=>normalizePng(cat([good,new Uint8Array([1])])))});
await test('noncontiguous IDAT rejected',()=>assert.rejects(()=>normalizePng(png(undefined,{post:[chunk('tEXt',new Uint8Array()),chunk('IDAT',new Uint8Array())]}))));
await test('4MP accepted; exceeding dimension or pixel cap rejected',async()=>{await normalizePng(png(new Uint8Array((4000*4+1)*1000),{w:4000,h:1000}));await assert.rejects(()=>normalizePng(png(new Uint8Array(5),{w:4001,h:1})));await assert.rejects(()=>normalizePng(png(new Uint8Array(5),{w:2001,h:2000}))) });
await test('64MiB inflate bomb with 1px header rejected quickly',async()=>{const compressed=new Uint8Array(deflateSync(new Uint8Array(64*1024*1024)));const started=performance.now();const before=process.memoryUsage().rss;await assert.rejects(()=>normalizePng(png(undefined,{compressed})));results.push({name:'bomb measurements',result:'INFO',compressedBytes:compressed.length,elapsedMs:Math.round(performance.now()-started),rssDeltaBytes:process.memoryUsage().rss-before})});
class Prepared{constructor(sql,q,args=[]){this.sql=sql;this.q=q;this.args=args}bind(...args){return new Prepared(this.sql,this.q,args)}async first(){return this.sql.prepare(this.q).get(...this.args)??null}async all(){return{results:this.sql.prepare(this.q).all(...this.args)}}}
const sql=new DatabaseSync(':memory:');for(const f of readdirSync(root+'/drizzle').filter(f=>f.endsWith('.sql')))sql.exec(readFileSync(root+'/drizzle/'+f,'utf8'));
const db={prepare:q=>new Prepared(sql,q),batch:async ps=>{sql.exec('BEGIN');try{const out=ps.map(p=>/^SELECT/i.test(p.q)?{results:sql.prepare(p.q).all(...p.args)}:sql.prepare(p.q).run(...p.args));sql.exec('COMMIT');return out}catch(e){sql.exec('ROLLBACK');throw e}}};
const objects=new Map();const r2={async put(key,b,opts){if(objects.has(key)&&opts?.onlyIf?.etagDoesNotMatch==='*')return null;objects.set(key,new Uint8Array(b));return {key}},async get(key,opts){const b=objects.get(key);if(!b)return null;const d=opts?.range?b.slice(opts.range.offset,opts.range.offset+opts.range.length):b;return {arrayBuffer:async()=>d.buffer.slice(d.byteOffset,d.byteOffset+d.byteLength),body:new Blob([d]).stream()}}};
const a=new BoardService(db,'owner-a',r2),b=new BoardService(db,'owner-b',r2);
const t=await a.mutate('create',{task:{title:'Synthetic image review'},requestKey:'task-review-01'});const attachment=await a.activity.upload(t.id,'upload-review-01',good,'fake.png');
const comment=await a.activity.mutate('add',{taskId:t.id,body:'Synthetic image',attachmentIds:[attachment.id],requestKey:'comment-review-01'});
await test('cross-owner image and comment reads rejected',async()=>{await assert.rejects(()=>b.activity.image(attachment.id),e=>e.status===404);await assert.rejects(()=>b.activity.get(comment.id),e=>e.status===404)});
async function capture(s){const p=[await s.backupPage(null,2)];while(p.at(-1).nextCursor)p.push(await s.backupPage(p.at(-1).nextCursor,2));return p}
const pages=await capture(a);
await test('complete backup validates baseline comment and blob',async()=>{const out=await validateBackup(pages);assert.equal(out.comments.length,1);assert.equal(out.blobs.size,1)});
async function rechain(ps){let prev=null;for(let i=0;i<ps.length;i++){const p=ps[i];p.sequence=i;p.previousChecksum=prev;const {checksum,nextCursor,...body}=p;p.checksum=await hash(stable(body));prev=p.checksum}return ps}
await test('backup validator rejects invalid historical comment attachment relationship',async()=>{const ps=structuredClone(pages);const ev=ps.flatMap(p=>p.commentHistory);const c=structuredClone(ev[0].after);c.revision=2;c.attachmentIds=[];ev[0].after.attachmentIds=[crypto.randomUUID()];const last=ps.find(p=>p.commentHistory.length);last.commentHistory.push({...ev[0],requestKey:'fake-next-01',before:ev[0].after,after:c});ps[0].counts.commentHistory++;await rechain(ps);await assert.rejects(()=>validateBackup(ps))});
await test('backup validator rejects malformed task history payload',async()=>{const ps=structuredClone(pages);ps.find(p=>p.history.length).history[0].after={id:t.id};await rechain(ps);await assert.rejects(()=>validateBackup(ps))});
await test('backup validator rejects inconsistent comment before snapshot',async()=>{const ps=structuredClone(pages);ps.find(p=>p.commentHistory.length).commentHistory[0].before={junk:true};await rechain(ps);await assert.rejects(()=>validateBackup(ps))});
await a.mutate('archive',{id:t.id,expectedRevision:t.revision,requestKey:'archive-review-01'});
const exp=await a.export(),preview=await b.preview(exp);
await test('archived image import initially succeeds',()=>b.import(exp,preview.digest,'copy-review-01'));
await test('identical archived image import retry succeeds',()=>b.import(exp,preview.digest,'copy-review-01'));
await test('preview rejects non-PNG image before any writes',async()=>{const bad=structuredClone(exp),bytes=new TextEncoder().encode('not a PNG');bad.attachments[0].dataBase64=base64(bytes);bad.attachments[0].size=bytes.length;bad.attachments[0].sha256=await hash(bytes);await assert.rejects(()=>b.preview(bad))});

await test('maximum legal Unicode filenames allow backup continuation',async()=>{const owner='unicode-owner';const s=new BoardService(db,owner,r2);const t=await s.mutate('create',{task:{title:'Synthetic cursor boundary'},requestKey:'cursor-task-01'});for(let i=0;i<100;i++){const id=crypto.randomUUID(),a={...attachment,id,taskId:t.id,filename:'界'.repeat(155)+'.png'};sql.prepare('INSERT INTO attachments(owner,id,task_id,payload,object_key,request_key,fingerprint,ready,size) VALUES(?,?,?,?,?,?,?,?,?)').run(owner,id,t.id,JSON.stringify(a),'fake-'+id,'fake-upload-'+i,'fake',1,a.size)}const p=await s.backupPage(null,2);results.push({name:'Unicode cursor measurement',result:'INFO',cursorLength:p.nextCursor.length});await s.backupPage(p.nextCursor,2)});
await test('image-free oversized export is rejected rather than returning unimportable data',async()=>{const s=new BoardService(db,'large-owner',r2);for(let i=0;i<70;i++)await s.mutate('create',{task:{title:'Synthetic long task '+i,evidenceNote:'x'.repeat(6000)},requestKey:'long-task-'+i});await assert.rejects(()=>s.export(),e=>e.code==='portable_limit')});
await test('preview rejects blank image-free comment',async()=>{const bad=structuredClone(exp);bad.comments[0].body='   ';bad.comments[0].attachmentIds=[];await assert.rejects(()=>b.preview(bad))});
await test('preview rejects duplicate attachment references',async()=>{const bad=structuredClone(exp);bad.comments[0].attachmentIds=[bad.attachments[0].id,bad.attachments[0].id];await assert.rejects(()=>b.preview(bad))});

if(results.some(r=>r.result==='FAIL'))process.exitCode=1;
console.log(JSON.stringify({pass:results.filter(r=>r.result==='PASS').length,fail:results.filter(r=>r.result==='FAIL').length},null,2));

const {recoverBackup}=await import('../scripts/recover-backup.mjs');
const {mkdtempSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
const destination=join(mkdtempSync(join(tmpdir(),'task-board-recovery-')),'recovered');
const outcome=await recoverBackup(pages,destination,'recovery-owner');assert.equal(outcome.complete,true);assert.equal((await recoverBackup(pages,destination,'recovery-owner')).complete,true);
const restoredSql=new DatabaseSync(outcome.database);const restoredDb={prepare:q=>new Prepared(restoredSql,q),batch:async ps=>{restoredSql.exec('BEGIN');try{const out=ps.map(p=>/^SELECT/i.test(p.q)?{results:restoredSql.prepare(p.q).all(...p.args)}:restoredSql.prepare(p.q).run(...p.args));restoredSql.exec('COMMIT');return out}catch(e){restoredSql.exec('ROLLBACK');throw e}}};
const restoredR2={async get(key,opts){const id=key.split('/').at(-1);const bytes=new Uint8Array(readFileSync(join(outcome.objects,id+'.png')));const d=opts?.range?bytes.slice(opts.range.offset,opts.range.offset+opts.range.length):bytes;return {arrayBuffer:async()=>d.buffer.slice(d.byteOffset,d.byteOffset+d.byteLength),body:new Blob([d]).stream()}}};
const restored=new BoardService(restoredDb,'recovery-owner',restoredR2);const captured=await validateBackup(pages),again=await validateBackup(await capture(restored));for(const k of ['tasks','history','snapshots','comments','commentHistory','attachments'])assert.deepEqual(again[k],captured[k]);assert.deepEqual([...again.blobs],[...captured.blobs]);await assert.rejects(()=>recoverBackup(pages,destination,'wrong-owner'));
console.log('PASS exact empty-destination recovery and identical retry preserve tasks, history, comments, images and relationships');

const statePath=join(destination,'recovery-state.json');const originalState=JSON.parse(readFileSync(statePath,'utf8'));writeFileSync(statePath,JSON.stringify({...originalState,complete:false}));writeFileSync(statePath+'.next','{"interrupted":');assert.equal((await recoverBackup(pages,destination,'recovery-owner')).complete,true);assert.equal(JSON.parse(readFileSync(statePath,'utf8')).complete,true);console.log('PASS recovery resumes after SQL commit with stale status and interrupted next-state write');
restoredSql.prepare('UPDATE tasks SET revision=revision+1 WHERE id=?').run(captured.tasks[0].id);await assert.rejects(()=>recoverBackup(pages,destination,'recovery-owner'),/Recovered tasks differ/);console.log('PASS matching-marker retries reverify restored rows and reject altered state');

const {mkdirSync,statSync}=await import('node:fs');const unsafeDestination=join(mkdtempSync(join(tmpdir(),'task-board-permissions-')),'shared');mkdirSync(unsafeDestination,{mode:0o755});await assert.rejects(()=>recoverBackup(pages,unsafeDestination,'recovery-owner'),/private directory/);assert.equal(statSync(outcome.database).mode&0o077,0);assert.equal(statSync(destination).mode&0o077,0);console.log('PASS recovery rejects non-private destinations and creates owner-only database files');
