import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {ZipReader,Uint8ArrayReader,Uint8ArrayWriter} from '@zip.js/zip.js';
import {Miniflare} from 'miniflare';
const {build}=createRequire(import.meta.resolve('wrangler/package.json'))('esbuild');
// Isolated workerd + real local D1/R2 semantics; no production credentials or network.
test('100 MiB original upload and 105 MiB ZIP download preserve bytes in workerd with R2 and D1',async t=>{
 const bundle=await build({stdin:{contents:`import {attachmentZipStream} from './lib/attachment-zip';import {BoardService} from './lib/service';import {execute} from './lib/operations';export default {async fetch(request,env){try{if(new URL(request.url).pathname==='/zip'){const service=new BoardService(env.DB,'synthetic-runtime-owner',env.IMAGES);const files=await service.activity.attachments(new URL(request.url).searchParams.get('taskId'));return new Response(attachmentZipStream(files,async id=>(await service.activity.image(id)).object.body))}const {name,args}=await request.json();return Response.json(await execute(new BoardService(env.DB,'synthetic-runtime-owner',env.IMAGES),name,args))}catch(e){return Response.json({error:e.message,code:e.code},{status:500})}}}`,resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,format:'esm',platform:'browser',external:['node:crypto'],logLevel:'silent'});
 // Explicit bundle module: zip.js has an unused dynamic codec loader; stored ZIPs never invoke it.
 const mf=new Miniflare({modules:[{type:'ESModule',path:'worker.js',contents:bundle.outputFiles[0].text}],compatibilityDate:'2026-05-15',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],r2Buckets:['IMAGES']});t.after(()=>mf.dispose());
 const db=await mf.getD1Database('DB');
 for(const file of (await readdir('drizzle')).filter(f=>f.endsWith('.sql')).sort())for(const statement of (await readFile('drizzle/'+file,'utf8')).split('--> statement-breakpoint').map(x=>x.trim()).filter(Boolean))await db.prepare(statement).run();
 const call=async(name,args)=>{const response=await mf.dispatchFetch('http://localhost/',{method:'POST',body:JSON.stringify({name,args})});const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));return result};
 const {task}=await call('create_task',{task:{title:'Synthetic runtime file test',sample:true},requestKey:'runtime-create-task'});
 const bytes=Buffer.alloc(5*1024*1024,77);bytes.set([255,216,255,224]);const checksum=createHash('sha256');for(let i=0;i<20;i++)checksum.update(bytes);
 const common={taskId:task.id,filename:'synthetic-100MiB.jpeg',requestKey:'runtime-large-file',totalSize:100*1024*1024,sha256:checksum.digest('hex'),dataBase64:bytes.toString('base64')};
 let result;for(let i=0;i<20;i++){result=await call('upload_attachment',{...common,offset:i*bytes.length});assert.equal(result.complete,i===19);if(i<19)assert.equal(result.nextOffset,(i+1)*bytes.length)}
 assert.equal(result.attachment.size,common.totalSize);
 const replay=await call('upload_attachment',{...common,offset:0});assert.deepEqual(replay,result);
 const tail=await call('get_attachment',{id:result.attachment.id,includeData:true,offset:common.totalSize-4,length:4});assert.deepEqual(Buffer.from(tail.dataBase64,'base64'),Buffer.alloc(4,77));
 // A board already holding 100 MiB must still accept another original.
 const extra=await call('upload_attachment',{taskId:task.id,filename:'next-photo.jpeg',requestKey:'runtime-next-photo',dataBase64:bytes.toString('base64')});assert.equal(extra.attachment.size,bytes.length);
 const zipped=await mf.dispatchFetch('http://localhost/zip?taskId='+task.id);assert.equal(zipped.status,200);
 const reader=new ZipReader(new Uint8ArrayReader(new Uint8Array(await zipped.arrayBuffer())),{useWebWorkers:false});
 const entries=await reader.getEntries();assert.equal(entries.length,2);
 for(const entry of entries){const restored=await entry.getData(new Uint8ArrayWriter(),{checkSignature:true});assert.equal(createHash('sha256').update(restored).digest('hex'),entry.filename==='synthetic-100MiB.jpeg'?common.sha256:extra.attachment.sha256)}await reader.close();
});
