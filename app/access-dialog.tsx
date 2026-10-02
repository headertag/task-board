'use client';
import {useEffect,useRef,useState} from 'react';
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription} from '@/components/ui/dialog';

type AccessMember={email:string,access:'read'|'write',active:boolean,bound:boolean,bootstrap?:boolean};
type AccessAction={action:'allow',email:string,access:'read'|'write'}|{action:'revoke',email:string};
type Props={open:boolean,canManageAccess?:boolean,canWrite?:boolean,onClose:()=>void,returnFocus:React.RefObject<HTMLElement|null>};

function membersFrom(value:unknown):AccessMember[]{
 const list=(value as {members?:unknown})?.members;
 if(!Array.isArray(list))throw new Error('Could not verify the allowed addresses. Reload before making another change.');
 return list.map(member=>{
  if(!member||typeof member.email!=='string'||!['read','write'].includes(member.access)||typeof member.active!=='boolean'||typeof member.bound!=='boolean')throw new Error('Could not verify the allowed addresses. Reload before making another change.');
  return {email:member.email,access:member.access,active:member.active,bound:member.bound,...(member.bootstrap===true?{bootstrap:true}:{})};
 });
}
async function accessRequest(action?:AccessAction,signal?:AbortSignal):Promise<AccessMember[]>{
 const response=await fetch('/api/access',{method:action?'POST':'GET',credentials:'same-origin',...(action?{headers:{'Content-Type':'application/json'},body:JSON.stringify(action)}:{}),signal});
 let value:any;try{value=await response.json()}catch{throw new Error('Could not reach access settings. Reload addresses before trying again.')}
 if(!response.ok)throw new Error(value.message||'Access could not be updated. Reload addresses before trying again.');
 return membersFrom(value);
}

export function AccessDialog({open,canManageAccess=false,canWrite=false,onClose,returnFocus}:Props){
 const [members,setMembers]=useState<AccessMember[]>([]),[email,setEmail]=useState(''),[access,setAccess]=useState<'read'|'write'>('read'),[loading,setLoading]=useState(false),[ready,setReady]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
 const epoch=useRef(0),loadAbort=useRef<AbortController|null>(null),mutationEpoch=useRef<number|null>(null),emailInput=useRef<HTMLInputElement>(null),permissionInput=useRef<HTMLSelectElement>(null);
 async function reload(){
  if(canManageAccess!==true||mutationEpoch.current!==null)return;
  const current=epoch.current;loadAbort.current?.abort();const controller=new AbortController();loadAbort.current=controller;setLoading(true);setError('');
  try{const result=await accessRequest(undefined,controller.signal);if(current===epoch.current){setMembers(result);setReady(true)}}catch(e){if(current===epoch.current&&!controller.signal.aborted)setError((e as Error).message)}finally{if(current===epoch.current&&!controller.signal.aborted)setLoading(false)}
 }
 useEffect(()=>{
  epoch.current++;if(!open||canManageAccess!==true)return;
  setMembers([]);setReady(false);setEmail('');setAccess('read');setBusy(false);setError('');setMessage('');void reload();
  return()=>{epoch.current++;loadAbort.current?.abort()};
 },[open,canManageAccess]);
 async function change(action:AccessAction,clearDraft=false){
  if(canManageAccess!==true||!canWrite||!ready||loading||mutationEpoch.current!==null)return;
  const current=epoch.current;mutationEpoch.current=current;setBusy(true);setError('');setMessage('');
  try{const result=await accessRequest(action);if(current!==epoch.current)return;setMembers(result);if(clearDraft){setEmail('');setAccess('read')}setMessage(action.action==='allow'?'Address allowed.':'Access revoked.')}
  catch(e){if(current===epoch.current)setError((e as Error).message)}
  finally{if(mutationEpoch.current===current)mutationEpoch.current=null;if(current===epoch.current)setBusy(false)}
 }
 function submit(event:React.FormEvent){event.preventDefault();const address=email.trim().toLowerCase();if(!address)return;if(members.some(member=>member.bootstrap&&member.email.toLowerCase()===address)){setError('Owner access is managed separately.');return}void change({action:'allow',email:address,access},true)}
 function close(){if(!busy)onClose()}
 if(canManageAccess!==true)return null;
 const existing=members.find(member=>member.email.toLowerCase()===email.trim().toLowerCase());
 return <Dialog open={open} onOpenChange={value=>{if(!value)close()}}><DialogContent className="access-dialog" onCloseAutoFocus={event=>{event.preventDefault();returnFocus.current?.focus()}} onInteractOutside={event=>{if(busy)event.preventDefault()}} onEscapeKeyDown={event=>{if(busy)event.preventDefault()}}>
  <DialogHeader><DialogTitle>Access</DialogTitle><DialogDescription>Allowed addresses share this board and can sign in with Google. No invitation emails are sent.</DialogDescription></DialogHeader>
  {!canWrite&&<p className="help">This board is read-only. Access changes are unavailable.</p>}
  <form onSubmit={submit} className="access-form"><fieldset disabled={busy||loading||!ready||!canWrite}>
   <label className="field"><span>Email address</span><input ref={emailInput} type="email" value={email} required autoComplete="off" onChange={event=>setEmail(event.target.value)}/></label>
   <label className="field"><span>Permission</span><select ref={permissionInput} value={access} onChange={event=>setAccess(event.target.value as 'read'|'write')}><option value="read">Can view</option><option value="write">Can view and edit</option></select></label>
   <button className="primary" type="submit" disabled={!email.trim()||existing?.bootstrap}>{busy?'Saving…':existing?.active?'Save access':'Add address'}</button>
  </fieldset></form>
  {error&&<p className="error" role="alert">{error}</p>}{message&&<p className="help" role="status">{message}</p>}
  <div className="section-heading"><h3>Allowed addresses</h3><button className="quiet" disabled={loading||busy} onClick={()=>void reload()}>Reload addresses</button></div>
  {loading?<p className="help" role="status">Loading allowed addresses…</p>:<ul className="access-members">{members.map(member=><li key={member.email}><div className="access-member-summary"><strong>{member.email}</strong><span>{member.bootstrap?'Owner':member.active?(member.access==='write'?'Can view and edit':'Can view'):'Revoked'}</span><small>{member.bound?'Google account verified':'Awaiting first Google sign-in'}</small></div>{!member.bootstrap&&<div className="access-member-actions">{member.active?<><button className="quiet" disabled={busy||loading||!canWrite} onClick={()=>{setEmail(member.email);setAccess(member.access);permissionInput.current?.focus()}}>Change access</button><button className="secondary" aria-label={`Revoke ${member.email}`} disabled={busy||loading||!canWrite} onClick={()=>void change({action:'revoke',email:member.email})}>Revoke</button></>:<button className="secondary" aria-label={`Allow ${member.email} again`} disabled={busy||loading||!canWrite} onClick={()=>void change({action:'allow',email:member.email,access:member.access})}>Allow again</button>}</div>}</li>)}</ul>}
 </DialogContent></Dialog>;
}
