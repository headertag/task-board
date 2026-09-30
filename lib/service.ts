import { z } from 'zod';
import { taskSchema,taskInput,validateTask,inputOf,nextOccurrence,samples,exportSchema, type Task } from './model';
export class AppError extends Error {constructor(public status:number,public code:string,message:string){super(message)}}
const keySchema=z.string().min(8).max(120).regex(/^[A-Za-z0-9_.:-]+$/);
const idSchema=z.string().uuid();
const revisionSchema=z.number().int().positive();
const parse=(r:any):Task=>taskSchema.parse(JSON.parse(r.payload));
function stable(v:any):string {return JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.keys(x).sort().reduce((o:any,k)=>(o[k]=x[k],o),{}):x)}
async function hash(s:string){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)))].map(b=>b.toString(16).padStart(2,'0')).join('')}
export class BoardService {
constructor(private db:D1Database,private owner:string){if(!owner)throw new AppError(401,'sign_in_required','Sign in to access your tasks')}
async list(archived=false){const r=await this.db.prepare('SELECT payload FROM tasks WHERE owner=? AND archived=? ORDER BY updated_at DESC LIMIT 501').bind(this.owner,archived?1:0).all();return r.results.map(parse)}
async get(id:string){idSchema.parse(id);const r=await this.db.prepare('SELECT payload FROM tasks WHERE owner=? AND id=?').bind(this.owner,id).first();if(!r)throw new AppError(404,'not_found','Task not found');return parse(r)}
async history(id:string){await this.get(id);const r=await this.db.prepare('SELECT action,before_json,after_json,created_at FROM task_events WHERE owner=? AND task_id=? ORDER BY created_at DESC LIMIT 100').bind(this.owner,id).all<any>();return r.results.map(x=>({action:x.action,before:x.before_json?JSON.parse(x.before_json):null,after:JSON.parse(x.after_json),createdAt:x.created_at}))}
async replay(key:string,fingerprint:string){const r=await this.db.prepare('SELECT fingerprint,after_json FROM task_events WHERE owner=? AND request_key=?').bind(this.owner,key).first<any>();if(!r)return null;if(r.fingerprint!==fingerprint)throw new AppError(409,'idempotency_conflict','This request key was already used for different input');return JSON.parse(r.after_json) as Task}
async mutate(action:'create'|'update'|'complete'|'archive'|'restore',args:any){
const key=keySchema.parse(args.requestKey);const fp=await hash(stable({action,...args}));const prior=await this.replay(key,fp);if(prior)return prior;
const now=new Date().toISOString();let before:Task|null=null;let next:Task;
if(action==='create'){const count=await this.db.prepare('SELECT COUNT(*) as n FROM tasks WHERE owner=?').bind(this.owner).first<{n:number}>();if((count?.n??0)>=100)throw new AppError(400,'pilot_limit','This pilot supports up to 100 tasks, including Trash');const input=validateTask(args.task);next={...input,id:crypto.randomUUID(),revision:1,createdAt:now,updatedAt:now,archived:false};}
else{before=await this.get(idSchema.parse(args.id));if(before.revision!==revisionSchema.parse(args.expectedRevision))throw new AppError(409,'revision_conflict','This task changed. Reload it before saving; your draft has not been applied');
next={...before,revision:before.revision+1,updatedAt:now};
if(action==='update'){const input=validateTask({...inputOf(before),...taskInput.partial().parse(args.patch)});if(input.status==='Completed'&&before.status!=='Completed')throw new AppError(400,'use_complete','Use Complete so recurrence and history are preserved');next={...next,...input};}
if(action==='complete'){if(before.archived)throw new AppError(400,'archived_task','Restore this task before completing it');if(before.status==='Completed')throw new AppError(409,'already_completed','This task is already completed');if(before.recurrence&&before.dueDate){next.dueDate=nextOccurrence(before.dueDate,before.recurrence);next.status='ToDo';next.attention='none';next.blocker='';}else next.status='Completed';}
if(action==='archive')next.archived=true;if(action==='restore')next.archived=false;
}
const body=JSON.stringify(next);const statements=[];
if(action==='create')statements.push(this.db.prepare('INSERT INTO tasks(owner,id,payload,status,archived,revision,updated_at,last_mutation) SELECT ?,?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM task_events WHERE owner=? AND request_key=?)').bind(this.owner,next.id,body,next.status,0,1,now,key,this.owner,key));
else statements.push(this.db.prepare('UPDATE tasks SET payload=?,status=?,archived=?,revision=?,updated_at=?,last_mutation=? WHERE owner=? AND id=? AND revision=? AND NOT EXISTS(SELECT 1 FROM task_events WHERE owner=? AND request_key=?)').bind(body,next.status,next.archived?1:0,next.revision,now,key,this.owner,next.id,before!.revision,this.owner,key));
statements.push(this.db.prepare('INSERT INTO task_events(owner,request_key,fingerprint,task_id,action,before_json,after_json,created_at) SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM tasks WHERE owner=? AND id=? AND last_mutation=?) ON CONFLICT(owner,request_key) DO NOTHING').bind(this.owner,key,fp,next.id,action,before?JSON.stringify(before):null,body,now,this.owner,next.id,key));
await this.db.batch(statements);const result=await this.replay(key,fp);if(!result)throw new AppError(409,'revision_conflict','This task changed. Reload it before saving; your draft has not been applied');return result;
}
async seed(){const existing=await this.db.prepare('SELECT COUNT(*) as n FROM tasks WHERE owner=?').bind(this.owner).first<{n:number}>();if((existing?.n??0)>0)return {tasks:await this.list()};let output=[];for(let i=0;i<samples.length;i++)output.push(await this.mutate('create',{requestKey:`sample-v1-${i}`,task:samples[i]}));return {tasks:output}}
async export(){const rows=await this.db.prepare('SELECT payload FROM tasks WHERE owner=? ORDER BY updated_at').bind(this.owner).all();if(rows.results.length>100)throw new AppError(400,'pilot_limit','This pilot supports export/import of up to 100 tasks');const events=await this.db.prepare('SELECT task_id,action,before_json,after_json,created_at FROM task_events WHERE owner=? ORDER BY created_at DESC LIMIT 2001').bind(this.owner).all<any>();if(events.results.length>2000)throw new AppError(400,'pilot_limit','History exceeds the pilot export limit');return {format:'task-board-pilot',version:1,exportedAt:new Date().toISOString(),tasks:rows.results.map(parse),history:events.results.map(e=>({taskId:e.task_id,action:e.action,before:e.before_json?JSON.parse(e.before_json):null,after:JSON.parse(e.after_json),createdAt:e.created_at}))};}
async preview(data:unknown){let parsed;try{parsed=exportSchema.parse(data);for(const t of parsed.tasks)validateTask(inputOf(t));}catch{throw new AppError(400,'invalid_import','Not a valid version 1 Task Board export (maximum 100 tasks). No changes were made')}
const ids=new Set(parsed.tasks.map(t=>t.id));if(ids.size!==parsed.tasks.length)throw new AppError(400,'invalid_import','Duplicate task IDs in import');const digest=await hash(stable(parsed));return {parsed,digest,summary:{taskCount:parsed.tasks.length,sampleCount:parsed.tasks.filter(t=>t.sample).length,archivedCount:parsed.tasks.filter(t=>t.archived).length,historyCount:parsed.history.length,mode:'Copies with new IDs. Existing tasks stay unchanged. Imported history is retained in the source snapshot.'}};}
async import(data:unknown,expectedDigest:string,requestKey:string){keySchema.parse(requestKey);const p=await this.preview(data);if(p.digest!==expectedDigest)throw new AppError(409,'preview_changed','The import changed. Preview it again');const existingSource=await this.db.prepare('SELECT payload FROM snapshots WHERE owner=? AND id=?').bind(this.owner,`source:${requestKey}`).first<{payload:string}>();if(existingSource&&await hash(stable(JSON.parse(existingSource.payload)))!==p.digest)throw new AppError(409,'idempotency_conflict','This import request key was already used for a different file');const before=await this.export();if(!existingSource&&before.tasks.length+p.parsed.tasks.length>100)throw new AppError(400,'pilot_limit','Import would exceed the pilot limit of 100 tasks, including Trash');await this.db.batch([
this.db.prepare('INSERT INTO snapshots(owner,id,payload,created_at) VALUES(?,?,?,?) ON CONFLICT(owner,id) DO NOTHING').bind(this.owner,`before:${requestKey}`,JSON.stringify(before),new Date().toISOString()),
this.db.prepare('INSERT INTO snapshots(owner,id,payload,created_at) VALUES(?,?,?,?) ON CONFLICT(owner,id) DO NOTHING').bind(this.owner,`source:${requestKey}`,JSON.stringify(p.parsed),new Date().toISOString())]);
let created=[];for(let i=0;i<p.parsed.tasks.length;i++){const t=p.parsed.tasks[i];const out=await this.mutate('create',{requestKey:`${requestKey}:${i}`,task:inputOf(t)});if(t.archived)await this.mutate('archive',{requestKey:`${requestKey}:${i}:archive`,id:out.id,expectedRevision:out.revision});created.push(out.id)}return {createdIds:created,snapshotId:`before:${requestKey}`,mode:'imported_as_copies'};}
async backupPage(cursor:string|null=null,pageSize=20){
pageSize=z.number().int().min(1).max(100).parse(pageSize);
const ownerTag=await hash(this.owner);
const encode=(v:any)=>btoa(JSON.stringify(v)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
let c:any;
if(!cursor){
const result=await this.db.batch([
this.db.prepare('SELECT payload FROM tasks WHERE owner=? ORDER BY id').bind(this.owner),
this.db.prepare('SELECT COALESCE(MAX(rowid),0) AS high,COUNT(*) AS count FROM task_events WHERE owner=?').bind(this.owner),
this.db.prepare('SELECT COALESCE(MAX(rowid),0) AS high,COUNT(*) AS count FROM snapshots WHERE owner=?').bind(this.owner)
]);
const eventMeta=result[1].results[0] as any,snapshotMeta=result[2].results[0] as any;
c={v:1,ownerTag,backupId:crypto.randomUUID(),capturedAt:new Date().toISOString(),historyHigh:Number(eventMeta.high),snapshotHigh:Number(snapshotMeta.high),phase:'history',after:0};
return {format:'task-board-backup-page',version:1,backupId:c.backupId,capturedAt:c.capturedAt,pageKind:'manifest',tasks:result[0].results.map(parse),history:[],snapshots:[],counts:{tasks:result[0].results.length,history:Number(eventMeta.count),snapshots:Number(snapshotMeta.count)},nextCursor:encode(c),complete:false};
}
try{const decoded=JSON.parse(atob(z.string().max(2000).parse(cursor).replaceAll('-','+').replaceAll('_','/')));c=z.object({v:z.literal(1),ownerTag:z.string(),backupId:z.string().uuid(),capturedAt:z.string().datetime(),historyHigh:z.number().int().nonnegative(),snapshotHigh:z.number().int().nonnegative(),phase:z.enum(['history','snapshots']),after:z.number().int().nonnegative()}).strict().parse(decoded);if(c.ownerTag!==ownerTag)throw new Error('owner');}catch{throw new AppError(400,'invalid_cursor','Invalid backup cursor for this signed-in user')}
const phase=c.phase;
const rows=await this.db.prepare(phase==='history'?'SELECT rowid AS position,request_key,fingerprint,task_id,action,before_json,after_json,created_at FROM task_events WHERE owner=? AND rowid>? AND rowid<=? ORDER BY rowid LIMIT ?':'SELECT rowid AS position,id,payload,created_at FROM snapshots WHERE owner=? AND rowid>? AND rowid<=? ORDER BY rowid LIMIT ?').bind(this.owner,c.after,phase==='history'?c.historyHigh:c.snapshotHigh,pageSize+1).all<any>();
const items=rows.results.slice(0,pageSize);let nextCursor:string|null=null;
if(rows.results.length>pageSize)nextCursor=encode({...c,after:Number(items[items.length-1].position)});
else if(phase==='history')nextCursor=encode({...c,phase:'snapshots',after:0});
return {format:'task-board-backup-page',version:1,backupId:c.backupId,capturedAt:c.capturedAt,pageKind:phase,tasks:[],history:phase==='history'?items.map(e=>({requestKey:e.request_key,fingerprint:e.fingerprint,taskId:e.task_id,action:e.action,before:e.before_json?JSON.parse(e.before_json):null,after:JSON.parse(e.after_json),createdAt:e.created_at})):[],snapshots:phase==='snapshots'?items.map(e=>({id:e.id,createdAt:e.created_at,data:JSON.parse(e.payload)})):[],nextCursor,complete:nextCursor===null};
}
async snapshots(){const r=await this.db.prepare('SELECT id,created_at FROM snapshots WHERE owner=? ORDER BY created_at DESC LIMIT 30').bind(this.owner).all();return r.results}
async snapshot(id:string){const r=await this.db.prepare('SELECT payload FROM snapshots WHERE owner=? AND id=?').bind(this.owner,z.string().max(150).parse(id)).first<any>();if(!r)throw new AppError(404,'not_found','Snapshot not found');return JSON.parse(r.payload)}
}
