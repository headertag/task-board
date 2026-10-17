import {createHash} from 'node:crypto';
export function multipartR2(objects) {
 const uploads=new Map();let completed=0;
 return {
  get multipartCompletions(){return completed},
  async head(key){const bytes=objects.get(key);return bytes?{key,size:bytes.length}:null},
  async createMultipartUpload(key){const uploadId=crypto.randomUUID();uploads.set(uploadId,{key,parts:new Map()});return this.resumeMultipartUpload(key,uploadId)},
  resumeMultipartUpload(key,uploadId){return {key,uploadId,
   async uploadPart(partNumber,bytes){const state=uploads.get(uploadId);if(!state||state.key!==key)throw new Error('Multipart upload unavailable');const stored=new Uint8Array(bytes);const etag=createHash('md5').update(stored).digest('hex');state.parts.set(partNumber,{bytes:stored,etag});return {partNumber,etag}},
   async abort(){uploads.delete(uploadId)},
   async complete(parts){const state=uploads.get(uploadId);if(!state)throw new Error('Multipart already completed');let size=0;for(const p of parts){const part=state.parts.get(p.partNumber);if(part?.etag!==p.etag)throw new Error('Invalid etag');size+=part.bytes.length}const bytes=new Uint8Array(size);let offset=0;for(const p of parts){const part=state.parts.get(p.partNumber);bytes.set(part.bytes,offset);offset+=part.bytes.length}objects.set(key,bytes);uploads.delete(uploadId);completed++;return {key,size}}
  }}
 };
}
