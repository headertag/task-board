import {ZipWriter} from '@zip.js/zip.js/lib/zip-core-writer.js';
import {createHash} from 'node:crypto';
import {AppError} from './errors';
import type {Attachment} from './model';

export function safeArchiveName(name:string) {
 const cleaned=name.normalize('NFC').replace(/[\x00-\x1f\x7f-\x9f/\\:*?"<>|\u202a-\u202e\u2066-\u2069]/g,'_').replace(/^[. ]+|[. ]+$/g,'').slice(0,160).replace(/[\uD800-\uDBFF]$/,'_');
 let safe='';const encoder=new TextEncoder();for(const character of cleaned){if(encoder.encode(safe+character).length>200)break;safe+=character}safe=safe||'attachment';
 return /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(safe)?'_'+safe:safe;
}
export function archiveEntryNames(files:Attachment[]) {
 const used=new Set<string>();
 return files.map(file=>{
  const base=safeArchiveName(file.filename),dot=base.lastIndexOf('.');
  const stem=dot>0?base.slice(0,dot):base,extension=dot>0?base.slice(dot):'';
  let name=base,index=2;
  while(used.has(name.toLowerCase()))name=`${stem} (${index++})${extension}`;
  used.add(name.toLowerCase());return name;
 });
}
// ZIP64 and stored entries preserve original bytes without compression work or
// buffering entire files. Backpressure reaches R2; a failed entry aborts the ZIP.
export function attachmentZipStream(files:Attachment[],open:(id:string)=>Promise<ReadableStream<Uint8Array>>,signal?:AbortSignal) {
 let output!:TransformStreamDefaultController<Uint8Array>;
 const stream=new TransformStream<Uint8Array,Uint8Array>({start(controller){output=controller}});
 const writer=new ZipWriter(stream.writable,{level:0,useWebWorkers:false,bufferedWrite:false,extendedTimestamp:false});
 const names=archiveEntryNames(files);
 void (async()=>{
  for(let i=0;i<files.length;i++){
   signal?.throwIfAborted();
   const file=files[i],checksum=createHash('sha256');let size=0;
   const body=await open(file.id);
   const checked=body.pipeThrough(new TransformStream<Uint8Array,Uint8Array>({
    transform(bytes,controller){size+=bytes.length;if(size>file.size)throw new AppError(503,'file_unavailable','An attachment is incomplete or corrupt; retry the download');checksum.update(bytes);controller.enqueue(bytes)},
    flush(){if(size!==file.size||checksum.digest('hex')!==file.sha256)throw new AppError(503,'file_unavailable','An attachment is incomplete or corrupt; retry the download')}
   }));
   await writer.add(names[i],checked,{signal,lastModDate:new Date(file.createdAt)});
  }
  await writer.close();
 })().catch(error=>output.error(error));
 return stream.readable;
}
