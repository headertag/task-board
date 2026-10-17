import {createHash} from 'node:crypto';
import {AppError} from './errors';
import {hash} from './safety';
import {UPLOAD_PART_SIZE} from './upload-limits';
import type {Attachment} from './model';

// Parts and whole-file identity are immutable, owner scoped, and durable before
// sending bytes to R2. A lost response can replay without duplicating a file.
export async function uploadPart(db:D1Database,owner:string,bucket:R2Bucket,attachment:Attachment,objectKey:string,bytes:Uint8Array,offset:number,ready:boolean) {
 const partNumber=offset/UPLOAD_PART_SIZE+1;
 const digest=await hash(bytes);
 await db.batch([db.prepare('INSERT INTO attachment_upload_parts(owner,attachment_id,part_number,sha256) VALUES(?,?,?,?) ON CONFLICT(owner,attachment_id,part_number) DO NOTHING').bind(owner,attachment.id,partNumber,digest)]);
 let part=await db.prepare('SELECT sha256,etag FROM attachment_upload_parts WHERE owner=? AND attachment_id=? AND part_number=?').bind(owner,attachment.id,partNumber).first<any>();
 if(part.sha256!==digest)throw new AppError(409,'idempotency_conflict','This upload part already contains different bytes');
 if(ready)return {attachment,complete:true,nextOffset:null};
 let session=await db.prepare('SELECT upload_id,created_at FROM attachment_uploads WHERE owner=? AND attachment_id=?').bind(owner,attachment.id).first<any>();
 if(!session){
   const candidate=await bucket.createMultipartUpload(objectKey,{httpMetadata:{contentType:'application/octet-stream'}});
   await db.batch([db.prepare('INSERT INTO attachment_uploads(owner,attachment_id,upload_id,created_at) VALUES(?,?,?,?) ON CONFLICT(owner,attachment_id) DO NOTHING').bind(owner,attachment.id,candidate.uploadId,new Date().toISOString())]);
   session=await db.prepare('SELECT upload_id,created_at FROM attachment_uploads WHERE owner=? AND attachment_id=?').bind(owner,attachment.id).first<any>();
   if(session.upload_id!==candidate.uploadId)await candidate.abort();
 }
 // R2 expires unfinished uploads after seven days. Renew before expiry while
 // retaining immutable part hashes; clients resend missing parts with the same key.
 if(Date.parse(session.created_at)<Date.now()-6*86400000){
   const previous=session.upload_id;
   const candidate=await bucket.createMultipartUpload(objectKey,{httpMetadata:{contentType:'application/octet-stream'}});
   await db.batch([
    db.prepare('UPDATE attachment_uploads SET upload_id=?,created_at=? WHERE owner=? AND attachment_id=? AND upload_id=?').bind(candidate.uploadId,new Date().toISOString(),owner,attachment.id,previous),
    db.prepare('UPDATE attachment_upload_parts SET etag=NULL WHERE owner=? AND attachment_id=? AND EXISTS(SELECT 1 FROM attachment_uploads WHERE owner=? AND attachment_id=? AND upload_id=?)').bind(owner,attachment.id,owner,attachment.id,candidate.uploadId)
   ]);
   session=await db.prepare('SELECT upload_id,created_at FROM attachment_uploads WHERE owner=? AND attachment_id=?').bind(owner,attachment.id).first<any>();
   if(session.upload_id!==candidate.uploadId)await candidate.abort();
   else await bucket.resumeMultipartUpload(objectKey,previous).abort().catch(()=>{});
   part=await db.prepare('SELECT sha256,etag FROM attachment_upload_parts WHERE owner=? AND attachment_id=? AND part_number=?').bind(owner,attachment.id,partNumber).first<any>();
 }
 const upload=bucket.resumeMultipartUpload(objectKey,session.upload_id);
 if(!part.etag){
   const receipt=await upload.uploadPart(partNumber,bytes);
   await db.batch([db.prepare('UPDATE attachment_upload_parts SET etag=? WHERE owner=? AND attachment_id=? AND part_number=? AND sha256=? AND EXISTS(SELECT 1 FROM attachment_uploads WHERE owner=? AND attachment_id=? AND upload_id=?)').bind(receipt.etag,owner,attachment.id,partNumber,digest,owner,attachment.id,session.upload_id)]);
 }
 const rows=(await db.prepare('SELECT part_number,etag FROM attachment_upload_parts WHERE owner=? AND attachment_id=? ORDER BY part_number').bind(owner,attachment.id).all<any>()).results;
 const count=Math.ceil(attachment.size/UPLOAD_PART_SIZE);
 const missing=Array.from({length:count},(_,i)=>i+1).find(i=>!rows.some(r=>r.part_number===i&&r.etag));
 if(missing)return {uploadId:attachment.id,complete:false,nextOffset:(missing-1)*UPLOAD_PART_SIZE};
 // complete() may have succeeded before the previous request lost its response.
 let object=await bucket.get(objectKey);
 if(!object){try{await upload.complete(rows.map(r=>({partNumber:r.part_number,etag:r.etag})))}catch(error){if(!await bucket.head(objectKey))throw error}object=await bucket.get(objectKey)}
 if(!object)throw new AppError(503,'file_unavailable','The uploaded file could not be verified; retry this part');
 const checksum=createHash('sha256');let size=0;
 const reader=object.body.getReader();
 try{while(true){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.length;if(size>attachment.size){await reader.cancel();throw new AppError(409,'file_checksum','Uploaded file size does not match')}checksum.update(chunk.value)}}finally{reader.releaseLock()}
 if(size!==attachment.size||checksum.digest('hex')!==attachment.sha256)throw new AppError(409,'file_checksum','Uploaded file checksum does not match; start a new upload');
 await db.batch([db.prepare('UPDATE attachments SET ready=1 WHERE owner=? AND id=?').bind(owner,attachment.id)]);
 return {attachment,complete:true,nextOffset:null};
}
