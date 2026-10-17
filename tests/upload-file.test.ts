import test from 'node:test';
import assert from 'node:assert/strict';
import {uploadOriginalFile} from '../app/upload-file';
import {FILE_LIMIT,UPLOAD_PART_SIZE} from '../lib/upload-limits';
import {hash} from '../lib/safety';
test('camera JPEG stays byte-for-byte original, without PNG decoding or conversion',async()=>{
 const bytes=Buffer.alloc(3*1024*1024,77);bytes.set([255,216,255,224]);
 const file=new File([bytes],'camera.jpeg',{type:'image/jpeg'});
 const out=await uploadOriginalFile(file,'task','camera-request',async(name,args)=>{assert.equal(name,'upload_attachment');assert.equal(args.contentType,'application/octet-stream');assert.equal(args.filename,'camera.jpeg');assert.deepEqual(Buffer.from(args.dataBase64,'base64'),bytes);return {attachment:{id:'saved'}}},new AbortController().signal,()=>{});
 assert.equal(out.id,'saved');
});
test('large originals use fixed parts and follow server resume offsets; cancellation stops further parts',async()=>{
 const file=new File([Buffer.alloc(UPLOAD_PART_SIZE*2+7,51)],'camera.heic');const calls:number[]=[];
 const sha=await hash(new Uint8Array(await file.arrayBuffer()));
 await uploadOriginalFile(file,'task','resume-key',async(_name,a)=>{calls.push(a.offset);assert.equal(a.sha256,sha);assert.equal(a.totalSize,file.size);assert.equal(Buffer.from(a.dataBase64,'base64').length,a.offset===0?UPLOAD_PART_SIZE:7);return a.offset===0?{complete:false,nextOffset:UPLOAD_PART_SIZE*2}:{complete:true,attachment:{id:'saved'}}},new AbortController().signal,()=>{});
 assert.deepEqual(calls,[0,UPLOAD_PART_SIZE*2]);
 const controller=new AbortController();let count=0;
 await assert.rejects(uploadOriginalFile(file,'task','cancel-key',async()=>{count++;controller.abort();return {complete:false,nextOffset:UPLOAD_PART_SIZE}},controller.signal,()=>{}),{name:'AbortError'});
 assert.equal(count,1);
});
test('files beyond 100 MiB are rejected before reading, while invalid server progress cannot loop',async()=>{
 await assert.rejects(uploadOriginalFile({size:FILE_LIMIT+1} as File,'task','key',async()=>assert.fail(),new AbortController().signal,()=>{}),/100 MB/);
 const file=new File([new Uint8Array(UPLOAD_PART_SIZE+1)],'file.bin');
 await assert.rejects(uploadOriginalFile(file,'task','key',async()=>({nextOffset:0}),new AbortController().signal,()=>{}),/Retry upload/);
});
