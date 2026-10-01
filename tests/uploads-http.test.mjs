import {loopbackUrl} from './loopback.mjs';
import {syntheticCredentials,credentialHeaders} from './synthetic-credentials.mjs';
import assert from 'node:assert/strict';
import {deflateSync} from 'node:zlib';
import {mkdirSync,writeFileSync} from 'node:fs';
import {crc32} from '../lib/image.ts';
import {validateBackup} from '../lib/backup.ts';
const url=loopbackUrl(process.env.TEST_URL);const credentials=syntheticCredentials();const headers=credentialHeaders(credentials),readHeaders=credentialHeaders(credentials,'read'),otherHeaders=credentialHeaders(credentials,'other');
const api=async(name,args={},custom=headers)=>{const r=await fetch(url+'/api/board',{method:'POST',headers:custom,body:JSON.stringify({name,args})});const text=await r.text();let data;try{data=JSON.parse(text)}catch{throw new Error('Action '+name+' returned '+r.status+': '+text)}return {status:r.status,data}};
for(const custom of [headers,otherHeaders]){for(const archived of [false,true]){const initial=await api('list_tasks',{archived},custom);assert.equal(initial.status,200);assert.equal(initial.data.tasks.length,0,'Use dedicated empty synthetic owners for this suite');}}
const taskResult=await api('create_task',{task:{title:'SAMPLE synthetic image task',sample:true,resources:[{kind:'product',label:'Example product',url:'https://example.com/item',address:''},{kind:'location',label:'Example place',url:'',address:'Fictional test address'}]},requestKey:'http-image-task-01'});assert.equal(taskResult.status,200,'Primary credentials need an approved custom write scope');const task=taskResult.data.task;
assert.equal((await api('get_task',{id:task.id},readHeaders)).data.task.id,task.id,'Read and write clients must resolve to the same synthetic record IDs');
function chunk(type,body){const out=Buffer.alloc(body.length+12);out.writeUInt32BE(body.length);out.write(type,4);out.set(body,8);out.writeUInt32BE(crc32(out.subarray(4,out.length-4)),out.length-4);return out}
const h=Buffer.alloc(13);h.writeUInt32BE(1);h.writeUInt32BE(1,4);h[8]=8;h[9]=6;const png=(raw)=>Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',h),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);const bytes=png(Buffer.from([0,255,128,0,255]));
const uploadHeaders={...headers,'content-type':'image/png',origin:url,'x-task-id':task.id,'x-upload-key':'upload-http-image-01','x-file-name':'synthetic.png'};
const upload=async(bytes,h=uploadHeaders)=>{const r=await fetch(url+'/api/images',{method:'POST',headers:h,body:bytes});return {status:r.status,data:await r.json()}};
assert.equal((await upload(bytes,{'content-type':'image/png',origin:url})).status,401);assert.equal((await upload(bytes,{...uploadHeaders,origin:'https://other.invalid'})).status,403);
assert.equal((await upload(bytes,{...uploadHeaders,...credentialHeaders(credentials,'read','image/png')})).status,403,'A read-only client cannot upload images');
let r=await upload(bytes);assert.equal(r.status,200,JSON.stringify(r.data));const attachment=r.data.attachment;assert.equal((await upload(bytes)).data.attachment.id,attachment.id);
assert.equal((await fetch(url+'/api/images?id='+attachment.id)).status,401);assert.equal((await fetch(url+'/api/images?id='+attachment.id,{headers:otherHeaders})).status,404);
let image=await fetch(url+'/api/images?id='+attachment.id,{headers:readHeaders});assert.equal(image.status,200);assert.equal(image.headers.get('content-type'),'image/png');assert.equal(image.headers.get('x-content-type-options'),'nosniff');assert.equal(image.headers.get('cross-origin-resource-policy'),'same-origin');assert.match(image.headers.get('cache-control'),/no-store/);assert.equal((await image.arrayBuffer()).byteLength,attachment.size);
assert.equal((await upload(Buffer.from('<svg/>'),{...uploadHeaders,'x-upload-key':'upload-http-bad-svg'})).status,400);
assert.equal((await upload(png(Buffer.alloc(64*1024*1024)),{...uploadHeaders,'x-upload-key':'upload-http-bomb01'})).status,400);
assert.equal((await api('list_tasks')).status,200,'Worker stays healthy after rejecting compressed bomb');
assert.equal((await upload(Buffer.alloc(2*1024*1024+1),{...uploadHeaders,'x-upload-key':'upload-http-large1'})).status,413);
assert.equal((await api('list_tasks')).status,200,'Worker stays healthy after oversized upload');
let comment=(await api('add_comment',{taskId:task.id,body:'<script>alert(1)</script> https://example.com/update',attachmentIds:[attachment.id],requestKey:'http-comment-01'})).data.comment;assert.ok(comment?.id);
assert.equal((await api('add_comment',{taskId:task.id,body:comment.body,attachmentIds:[attachment.id],requestKey:'http-comment-01'})).data.comment.id,comment.id);
assert.equal((await api('edit_comment',{id:comment.id,expectedRevision:77,body:'stale',requestKey:'http-comment-stale'})).status,409);
comment=(await api('edit_comment',{id:comment.id,expectedRevision:comment.revision,body:'Updated synthetic comment',attachmentIds:[attachment.id],requestKey:'http-comment-edit'})).data.comment;
assert.equal((await api('get_comment',{id:comment.id},otherHeaders)).status,404);
assert.equal((await api('get_comment',{id:comment.id},readHeaders)).data.comment.id,comment.id);
assert.equal((await api('add_comment',{taskId:task.id,body:'SAMPLE rejected read-only comment',requestKey:'http-comment-readonly'},readHeaders)).status,403);
assert.equal((await api('update_task',{id:task.id,expectedRevision:task.revision,patch:{resources:[{kind:'product',label:'Unsafe',url:'javascript:alert(1)',address:''}]},requestKey:'http-invalid-link'})).status,400);
assert.equal((await api('update_task',{id:task.id,expectedRevision:task.revision,patch:{sourceUrl:'https://name:pass@example.com'},requestKey:'http-invalid-cred'})).status,400);
const pages=[(await api('export_backup_page')).data];while(pages.at(-1).nextCursor)pages.push((await api('export_backup_page',{cursor:pages.at(-1).nextCursor,pageSize:2})).data);const validated=await validateBackup(pages);assert.equal(validated.comments.length,1);assert.equal(validated.attachments.length,1);assert.equal(validated.blobs.size,1);
const exported=(await api('export_tasks')).data;assert.equal(exported.version,2);assert.equal(exported.comments.length,1);assert.equal((await api('preview_import',{data:exported})).status,200);
mkdirSync('.sites-runtime',{recursive:true});writeFileSync('.sites-runtime/image-persistence-probe.json',JSON.stringify({version:2,synthetic:true,url,ownerId:credentials.ownerId,taskId:task.id,commentId:comment.id,imageId:attachment.id}),{mode:0o600});
console.log('PASS built workerd: private image auth/isolation, normalized uploads, idempotency, malformed/oversized/bomb rejection, comments, safe URLs, checksummed complete backup and portable preview');

async function mcp(name,args={},custom=headers){const r=await fetch(url+'/mcp',{method:'POST',headers:custom,body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});assert.equal(r.status,200);const rpc=await r.json();assert.equal(rpc.result.isError,false,JSON.stringify(rpc));return JSON.parse(rpc.result.content[0].text)}
const mcpPages=[await mcp('export_backup_page',{pageSize:2})];while(mcpPages.at(-1).nextCursor)mcpPages.push(await mcp('export_backup_page',{cursor:mcpPages.at(-1).nextCursor,pageSize:2}));const mcpBackup=await validateBackup(mcpPages);assert.equal(mcpBackup.blobs.size,1);assert.deepEqual([...mcpBackup.blobs],[...validated.blobs]);
const mcpExport=await mcp('export_tasks');assert.equal(mcpExport.attachments.length,1);const p=await mcp('preview_import',{data:mcpExport},otherHeaders);const imported=await mcp('import_tasks',{data:mcpExport,digest:p.digest,requestKey:'mcp-image-import-01'},otherHeaders);assert.equal(imported.createdIds.length,1);const copy=await mcp('export_tasks',{},otherHeaders);assert.equal(copy.attachments.length,1);assert.equal(copy.comments[0].attachmentIds[0],copy.attachments[0].id);assert.notEqual(copy.attachments[0].id,mcpExport.attachments[0].id);
console.log('PASS remote MCP complete image backup, portable image export and copy-import share the REST R2 binding');
