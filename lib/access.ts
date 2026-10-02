import { z } from 'zod';
import { AppError } from './errors';

export type AccessRole = 'read' | 'write';
export type AccessMember = {email:string;access:AccessRole;active:boolean;bound:boolean};
export type AccessGrant = {ownerId:string;email:string;access:AccessRole;active:boolean;providerId:string|null;workosUserId:string|null;version:number};
const ownerSchema=z.string().min(1).max(200).refine(v=>v===v.trim()&&!/[\u0000-\u001f\u007f]/.test(v));
const userSchema=z.string().regex(/^user_[A-Za-z0-9_-]+$/).max(200);
const providerSchema=z.string().min(1).max(256).refine(v=>v===v.trim()&&!/[\u0000-\u001f\u007f]/.test(v));
const columns='owner,email,access,active,google_provider_id,workos_user_id,version';
export function normalizeAccessEmail(value:unknown):string {
 if(typeof value!=='string')throw new AppError(400,'invalid_email','Enter a valid email address');
 const email=value.trim().toLowerCase();
 if(!email||email.length>320||!/^\S+@[^\s@]+\.[^\s@]+$/.test(email)||/[\u0000-\u001f\u007f]/.test(email)||email.split('@').length!==2)throw new AppError(400,'invalid_email','Enter a valid email address');
 return email;
}
function grant(row:any):AccessGrant {
 try {
  const ownerId=ownerSchema.parse(row.owner),email=normalizeAccessEmail(row.email);
  if(row.email!==email||!['read','write'].includes(row.access)||![0,1].includes(row.active)||!Number.isSafeInteger(row.version)||row.version<1||(row.google_provider_id===null)!==(row.workos_user_id===null))throw new Error();
  return {ownerId,email,access:row.access,active:row.active===1,providerId:row.google_provider_id===null?null:providerSchema.parse(row.google_provider_id),workosUserId:row.workos_user_id===null?null:userSchema.parse(row.workos_user_id),version:row.version};
 }catch{throw new AppError(503,'access_unavailable','Board access verification is temporarily unavailable')}
}
function safe(member:AccessGrant):AccessMember{return {email:member.email,access:member.access,active:member.active,bound:member.providerId!==null}}

/** Only server-verified callers may supply owner/actor identities to this store. */
export class AccessStore {
 constructor(private db:D1Database){}
 private async guarded<T>(operation:()=>Promise<T>):Promise<T>{try{return await operation()}catch(error){if(error instanceof AppError||error instanceof z.ZodError)throw error;throw new AppError(503,'access_unavailable','Board access verification is temporarily unavailable')}}
 private event(action:string,actor:string,id:string,owner:string,email:string,now:string){
  return this.db.prepare(`INSERT INTO access_events(owner,id,email,action,actor_user_id,access,active,google_provider_id,workos_user_id,version,created_at) SELECT owner,?,?,?, ?,access,active,google_provider_id,workos_user_id,version,? FROM access_grants WHERE owner=? AND email=? AND last_action_id=?`).bind(id,email,action,actor,now,owner,email,id);
 }
 async list(ownerId:string):Promise<AccessMember[]>{return this.guarded(async()=>{ownerSchema.parse(ownerId);const out=await this.db.prepare(`SELECT ${columns} FROM access_grants WHERE owner=? ORDER BY email LIMIT 1001`).bind(ownerId).all();if(out.results.length>1000)throw new AppError(503,'access_unavailable','Board access verification is temporarily unavailable');return out.results.map(row=>safe(grant(row)))})}
 async allow(input:{ownerId:string;email:string;access:AccessRole;actorWorkosUserId:string}):Promise<void>{return this.guarded(async()=>{
  const owner=ownerSchema.parse(input.ownerId),email=normalizeAccessEmail(input.email),access=z.enum(['read','write']).parse(input.access),actor=userSchema.parse(input.actorWorkosUserId),id=crypto.randomUUID(),now=new Date().toISOString();
  await this.db.batch([
   this.db.prepare(`INSERT INTO access_grants(owner,email,access,active,version,created_at,updated_at,last_action_id,last_actor_user_id) SELECT ?,?,?,1,1,?,?,?,? WHERE (SELECT COUNT(*) FROM access_grants WHERE owner=?)<1000 OR EXISTS(SELECT 1 FROM access_grants WHERE owner=? AND email=?) ON CONFLICT(owner,email) DO UPDATE SET access=excluded.access,active=1,version=access_grants.version+1,updated_at=excluded.updated_at,last_action_id=excluded.last_action_id,last_actor_user_id=excluded.last_actor_user_id`).bind(owner,email,access,now,now,id,actor,owner,owner,email),
   this.event('allow',actor,id,owner,email,now),
  ]);
  if(!await this.db.prepare('SELECT id FROM access_events WHERE owner=? AND id=?').bind(owner,id).first())throw new AppError(400,'access_limit','This board supports up to 1000 retained access entries');
 })}
 async revoke(input:{ownerId:string;email:string;actorWorkosUserId:string}):Promise<void>{return this.guarded(async()=>{
  const owner=ownerSchema.parse(input.ownerId),email=normalizeAccessEmail(input.email),actor=userSchema.parse(input.actorWorkosUserId),id=crypto.randomUUID(),now=new Date().toISOString();
  await this.db.batch([
   this.db.prepare('UPDATE access_grants SET active=0,version=version+1,updated_at=?,last_action_id=?,last_actor_user_id=? WHERE owner=? AND email=?').bind(now,id,actor,owner,email),
   this.event('revoke',actor,id,owner,email,now),
  ]);
  if(!await this.db.prepare('SELECT id FROM access_events WHERE owner=? AND id=?').bind(owner,id).first())throw new AppError(404,'access_not_found','This email address is not on the board access list');
 })}
 async find(email:string,ownerIds:readonly string[]):Promise<AccessGrant[]>{return this.guarded(async()=>{
  email=normalizeAccessEmail(email);const allowed=new Set(ownerIds.map(owner=>ownerSchema.parse(owner))),out=await this.db.prepare(`SELECT ${columns} FROM access_grants WHERE email=? AND active=1 LIMIT 1001`).bind(email).all();
  if(out.results.length>1000)throw new AppError(503,'access_unavailable','Board access verification is temporarily unavailable');
  return out.results.map(grant).filter(member=>allowed.has(member.ownerId));
 })}
 async pin(member:AccessGrant,identity:{providerId:string;workosUserId:string}):Promise<AccessGrant|null>{return this.guarded(async()=>{
  const owner=ownerSchema.parse(member.ownerId),email=normalizeAccessEmail(member.email),provider=providerSchema.parse(identity.providerId),user=userSchema.parse(identity.workosUserId);
  if(!member.active||!Number.isSafeInteger(member.version)||member.version<1)return null;
  if(member.providerId===null&&member.workosUserId===null){
   const id=crypto.randomUUID(),now=new Date().toISOString();
   await this.db.batch([
    this.db.prepare('UPDATE access_grants SET google_provider_id=?,workos_user_id=?,version=version+1,updated_at=?,last_action_id=?,last_actor_user_id=? WHERE owner=? AND email=? AND active=1 AND version=? AND google_provider_id IS NULL AND workos_user_id IS NULL').bind(provider,user,now,id,user,owner,email,member.version),
    this.event('bind',user,id,owner,email,now),
   ]);
  }
  const row=await this.db.prepare(`SELECT ${columns} FROM access_grants WHERE owner=? AND email=? AND active=1`).bind(owner,email).first();if(!row)return null;
  const current=grant(row);return current.providerId===provider&&current.workosUserId===user?current:null;
 })}
}
