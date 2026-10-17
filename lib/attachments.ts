import {FILE_LIMIT,UPLOAD_PART_SIZE,UPLOAD_BASE64_LIMIT} from './upload-limits';
import { z } from 'zod';
import { normalizePng } from './image';
import { AppError } from './errors';
import { hash, stable } from './safety';

export const uploadInput = z.object({
  taskId: z.string().uuid(), requestKey: z.string().min(8).max(100),
  filename: z.string().min(1).max(160),
  contentType: z.enum(['image/png', 'application/octet-stream']).default('application/octet-stream'),
  dataBase64: z.string().min(4).max(UPLOAD_BASE64_LIMIT).regex(/^[A-Za-z0-9+/]+={0,2}$/).refine(s=>s.length%4===0,'Invalid base64 length'),
  totalSize:z.number().int().positive().max(FILE_LIMIT).optional(),
  sha256:z.string().regex(/^[a-f0-9]{64}$/).optional(),
  offset:z.number().int().nonnegative().multipleOf(UPLOAD_PART_SIZE).optional(),
}).strict().superRefine((a,ctx)=>{
 const decodedSize=a.dataBase64.length/4*3-(a.dataBase64.endsWith('==')?2:a.dataBase64.endsWith('=')?1:0);
 if(decodedSize>UPLOAD_PART_SIZE)ctx.addIssue({code:'custom',message:'Send at most 5 MB per upload part'});
 if(a.totalSize!==undefined||a.sha256!==undefined||a.offset!==undefined){
  if(a.totalSize===undefined||a.sha256===undefined||a.offset===undefined||a.contentType!=='application/octet-stream'||a.offset>=a.totalSize)ctx.addIssue({code:'custom',message:'Chunk uploads need totalSize, sha256, offset and application/octet-stream'});
 }
});
export async function prepareAttachment(bytes: Uint8Array, contentType: 'image/png' | 'application/octet-stream') {
  if (!bytes.length || bytes.length > FILE_LIMIT) throw new AppError(400, 'file_size', 'Choose a nonempty file up to 100 MB');
  if (contentType === 'image/png') return normalizePng(bytes);
  return {bytes, width: 0, height: 0};
}
// Preserve historical PNG fingerprints, while distinguishing exact-byte files.
export async function attachmentFingerprint(a: {taskId:string,sha256:string,filename:string,contentType:string}) {
  return hash(stable({taskId:a.taskId,digest:a.sha256,filename:a.filename,...(a.contentType==='image/png'?{}:{contentType:a.contentType})}));
}
