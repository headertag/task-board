import { z } from 'zod';
import { normalizePng, IMAGE_LIMIT } from './image';
import { AppError } from './errors';
import { hash, stable } from './safety';

export const uploadInput = z.object({
  taskId: z.string().uuid(), requestKey: z.string().min(8).max(100),
  filename: z.string().min(1).max(160),
  contentType: z.enum(['image/png', 'application/octet-stream']).default('application/octet-stream'),
  dataBase64: z.string().min(4).max(2796204).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
}).strict();
export async function prepareAttachment(bytes: Uint8Array, contentType: 'image/png' | 'application/octet-stream') {
  if (!bytes.length || bytes.length > IMAGE_LIMIT) throw new AppError(400, 'file_size', 'Choose a nonempty file up to 2 MB');
  if (contentType === 'image/png') return normalizePng(bytes);
  return {bytes, width: 0, height: 0};
}
// Preserve historical PNG fingerprints, while distinguishing exact-byte files.
export async function attachmentFingerprint(a: {taskId:string,sha256:string,filename:string,contentType:string}) {
  return hash(stable({taskId:a.taskId,digest:a.sha256,filename:a.filename,...(a.contentType==='image/png'?{}:{contentType:a.contentType})}));
}
