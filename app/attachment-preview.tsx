"use client";
import {useState} from 'react';
import {Paperclip} from 'lucide-react';
import type {Attachment} from '../lib/model';
import {attachmentPreviewPath} from '../lib/attachment-preview';

export function AttachmentPreview({attachment,onOpen}:{attachment:Attachment;onOpen:(a:Attachment)=>void}) {
  const [failed,setFailed]=useState(false);
  const preview=attachmentPreviewPath(attachment);
  if(!preview||failed)return <a className="resource-action attachment-download" href={`/api/images?id=${encodeURIComponent(attachment.id)}`} download={attachment.filename}><Paperclip size={16}/>{attachment.filename}</a>;
  return <button type="button" className="image-thumb" aria-label={`Preview ${attachment.filename}`} title={attachment.filename} onClick={()=>onOpen(attachment)}><img src={preview} alt={attachment.filename} loading="lazy" onError={()=>setFailed(true)}/><span>{attachment.filename}</span></button>;
}
