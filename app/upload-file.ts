import {FILE_LIMIT,UPLOAD_PART_SIZE} from '../lib/upload-limits';
import {base64,hash} from '../lib/safety';
export async function uploadOriginalFile(file:File,taskId:string,requestKey:string,call:(name:string,args:any,signal?:AbortSignal)=>Promise<any>,signal:AbortSignal,progress:(text:string)=>void) {
 if(!file.size||file.size>FILE_LIMIT)throw new Error('Choose a nonempty file up to 100 MB');
 const check=()=>{if(signal.aborted)throw new DOMException('Upload paused','AbortError')};
 const common={taskId,requestKey,filename:file.name,contentType:'application/octet-stream'};
 if(file.size<=UPLOAD_PART_SIZE){progress(`Uploading ${file.name}…`);const bytes=new Uint8Array(await file.arrayBuffer());check();const result=await call('upload_attachment',{...common,dataBase64:base64(bytes)},signal);check();return result.attachment}
 progress(`Checking ${file.name}…`);
 const sha256=await (async()=>hash(new Uint8Array(await file.arrayBuffer())))();check();
 let offset=0;
 while(offset<file.size){
  progress(`Uploading ${file.name}: ${Math.floor(offset/file.size*100)}%`);
  const bytes=new Uint8Array(await file.slice(offset,offset+UPLOAD_PART_SIZE).arrayBuffer());check();
  const result=await call('upload_attachment',{...common,dataBase64:base64(bytes),totalSize:file.size,sha256,offset},signal);check();
  if(result.complete&&result.attachment){progress(`Uploaded ${file.name}`);return result.attachment}
  if(!Number.isInteger(result.nextOffset)||result.nextOffset<0||result.nextOffset>=file.size||result.nextOffset===offset)throw new Error('Upload progress could not be confirmed. Retry upload.');
  offset=result.nextOffset;
 }
 throw new Error('Upload did not finish. Retry upload.');
}
