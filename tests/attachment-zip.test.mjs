import test from 'node:test';
import assert from 'node:assert/strict';
import {ZipReader,Uint8ArrayReader,Uint8ArrayWriter} from '@zip.js/zip.js';
import {attachmentZipStream,archiveEntryNames} from '../lib/attachment-zip.ts';
import {hash} from '../lib/safety.ts';
async function file(name,bytes){return {id:crypto.randomUUID(),filename:name,size:bytes.length,sha256:await hash(bytes),createdAt:'2026-01-01T00:00:00.000Z'}}
async function readZip(bytes){const reader=new ZipReader(new Uint8ArrayReader(bytes),{useWebWorkers:false});const entries=await reader.getEntries();const result=[];for(const entry of entries)result.push({name:entry.filename,bytes:await entry.getData(new Uint8ArrayWriter(),{checkSignature:true})});await reader.close();return result}
test('streamed ZIP preserves originals, Unicode and duplicate names; no extra/missing entries',async()=>{
 const data=[Buffer.from('first original'),Buffer.from('second original'),Buffer.alloc(3*1024*1024,59),Buffer.from('unicode')];
 const names=['photo.jpeg','PHOTO.jpeg','photo (2).jpeg','café.pdf'];const files=await Promise.all(data.map((b,i)=>file(names[i],b)));
 const stream=attachmentZipStream(files,async id=>new Blob([data[files.findIndex(f=>f.id===id)]]).stream());
 const entries=await readZip(new Uint8Array(await new Response(stream).arrayBuffer()));assert.deepEqual(entries.map(e=>e.name),['photo.jpeg','PHOTO (2).jpeg','photo (2) (2).jpeg','café.pdf']);
 for(let i=0;i<data.length;i++)assert.deepEqual(Buffer.from(entries[i].bytes),data[i]);
});
test('archive entries cannot contain paths, Windows device names, control or bidi characters',()=>{
 const names=archiveEntryNames(['../../escape.txt','C:\\folder\\evil.txt','CON.txt','..','a\u202eb.txt','a\u0000b.txt'].map(filename=>({filename})));
 for(const name of names){assert.doesNotMatch(name,/[\\/:\x00-\x1f\u202e]/);assert.ok(!name.startsWith('.'));assert.notEqual(name,'CON.txt')}
 assert.equal(new Set(names.map(n=>n.toLowerCase())).size,names.length);
});
test('missing, short and corrupt objects abort the entire download rather than emitting a valid partial ZIP',async()=>{
 const bytes=Buffer.from('original'),f=await file('file.txt',bytes);
 for(const open of [async()=>{throw new Error('missing')},async()=>new Blob([bytes.subarray(1)]).stream(),async()=>new Blob([Buffer.from('different')]).stream()])await assert.rejects(new Response(attachmentZipStream([f],open)).arrayBuffer());
});
test('canceling download cancels source reads and does not open subsequent files',async()=>{
 const bytes=new Uint8Array(1024),files=[await file('one.bin',bytes),await file('two.bin',bytes)];let canceled=false,opens=0;
 const stream=attachmentZipStream(files,async()=>{opens++;return new ReadableStream({pull(c){c.enqueue(bytes)},cancel(){canceled=true}})});
 const reader=stream.getReader();await reader.read();await reader.cancel();
 await new Promise(resolve=>setTimeout(resolve,30));assert.equal(opens,1);assert.equal(canceled,true);
});
