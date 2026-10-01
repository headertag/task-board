// One-time, owner-scoped migration. Routine deployments never call this script.
import {open, lstat} from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateBackup} from '../lib/backup.ts';
import {normalizePng} from '../lib/image.ts';
import {hash, stable, stableId} from '../lib/safety.ts';

export class MigrationError extends Error {
  constructor(code) { super(`Migration stopped (${code}); destination writes must remain disabled.`); this.code=code; }
}
const stop = code => { throw new MigrationError(code); };
const tables = {
  tasks: ['owner','id','payload','status','archived','revision','updated_at','last_mutation'],
  task_events: ['owner','request_key','fingerprint','task_id','action','before_json','after_json','created_at'],
  snapshots: ['owner','id','payload','created_at'],
  comments: ['owner','id','task_id','payload','revision','last_mutation'],
  comment_events: ['owner','request_key','fingerprint','comment_id','task_id','action','before_json','after_json','created_at'],
  attachments: ['owner','id','task_id','payload','object_key','request_key','fingerprint','ready','size'],
};
const keyColumn = table => table.endsWith('_events') ? 'request_key' : 'id';
const canonical = rows => rows.map(stable).sort();

/** Validate everything locally before contacting a destination. */
export async function prepareMigration(pages, suppliedOwner) {
  let data;
  try { data=await validateBackup(pages); } catch { stop('invalid_capture'); }
  if (data.manifest.version!==3) stop('migration_capture_required');
  const owner=suppliedOwner??data.manifest.storageOwner;
  if (owner!==data.manifest.storageOwner || await hash(owner)!==data.manifest.ownerTag) stop('owner_mismatch');
  const ownerHash=data.manifest.ownerTag, retries=new Map(data.uploadRetries.map(r=>[r.attachmentId,r]));
  for (const a of data.attachments) {
    const r=retries.get(a.id);
    if (!r || await stableId(`${owner}:upload:${r.requestKey}`)!==a.id) stop('upload_identity_mismatch');
    const png=await normalizePng(data.blobs.get(a.id));
    if (png.width!==a.width || png.height!==a.height) stop('invalid_image');
  }
  const rows={
    tasks:data.tasks.map(t=>({owner,id:t.id,payload:JSON.stringify(t),status:t.status,archived:Number(t.archived),revision:t.revision,updated_at:t.updatedAt,last_mutation:data.history.filter(e=>e.taskId===t.id).at(-1).requestKey})),
    task_events:data.history.map(e=>({owner,request_key:e.requestKey,fingerprint:e.fingerprint,task_id:e.taskId,action:e.action,before_json:e.before?JSON.stringify(e.before):null,after_json:JSON.stringify(e.after),created_at:e.createdAt})),
    snapshots:data.snapshots.map(s=>({owner,id:s.id,payload:JSON.stringify(s.data),created_at:s.createdAt})),
    comments:data.comments.map(c=>({owner,id:c.id,task_id:c.taskId,payload:JSON.stringify(c),revision:c.revision,last_mutation:data.commentHistory.filter(e=>e.commentId===c.id).at(-1).requestKey})),
    comment_events:data.commentHistory.map(e=>({owner,request_key:e.requestKey,fingerprint:e.fingerprint,comment_id:e.commentId,task_id:e.taskId,action:e.action,before_json:e.before?JSON.stringify(e.before):null,after_json:JSON.stringify(e.after),created_at:e.createdAt})),
    attachments:data.attachments.map(a=>({owner,id:a.id,task_id:a.taskId,payload:JSON.stringify(a),object_key:`images/${ownerHash}/${a.id}`,request_key:retries.get(a.id).requestKey,fingerprint:retries.get(a.id).fingerprint,ready:1,size:a.size})),
  };
  return {owner,ownerHash,rows,data,digest:await hash(stable(pages))};
}

function configuration(options) {
  if (options.approved!==true || !/^[a-f0-9]{32}$/i.test(options.accountId??'') || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(options.databaseId??'') ||
      options.databaseId==='00000000-0000-4000-8000-000000000000' || !/^[A-Za-z0-9_-]{1,64}$/.test(options.databaseName??'') || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(options.bucketName??'')) stop('configuration');
  let origin; try { origin=new URL(options.origin); } catch { stop('configuration'); }
  if (origin.protocol!=='https:' || origin.username || origin.password || origin.pathname!=='/' || origin.search || origin.hash ||
      !/^task-board\.[a-z0-9-]+\.workers\.dev$/.test(origin.hostname)) stop('configuration');
  return origin.origin;
}

/** The transport uses the same account APIs as the locked Wrangler CLI. */
export function cloudflareTransport(options, fetcher=fetch) {
  if (typeof options.apiToken!=='string' || !options.apiToken || options.apiToken.length>16384 || /[\s\x00-\x1f\x7f]/.test(options.apiToken)) stop('credentials');
  const base=`https://api.cloudflare.com/client/v4/accounts/${options.accountId}`;
  async function request(url, init={}, binary=false, missing=false) {
    let response;
    try { response=await fetcher(url,{...init,redirect:'manual',headers:{Authorization:`Bearer ${options.apiToken}`,...init.headers},signal:AbortSignal.timeout(30000)}); }
    catch { stop('remote_request'); }
    if (response.redirected || response.url && response.url!==url || response.status>=300&&response.status<400) stop('remote_redirect');
    if (missing&&response.status===404) return null;
    if (!response.ok) stop(response.status===401||response.status===403?'remote_authorization':'remote_request');
    if (binary) return new Uint8Array(await response.arrayBuffer());
    let body; try { body=await response.json(); } catch { stop('remote_response'); }
    if (body?.success!==true) stop('remote_response');
    return body.result;
  }
  const objectUrl=key=>`${base}/r2/buckets/${options.bucketName}/objects/${key.split('/').map(encodeURIComponent).join('/')}`;
  return {
    async inspect() {
      const db=await request(`${base}/d1/database/${options.databaseId}`);
      const settings=await request(`${base}/workers/scripts/task-board/settings`);
      const bucket=await request(`${base}/r2/buckets/${options.bucketName}`);
      const managed=await request(`${base}/r2/buckets/${options.bucketName}/domains/managed`);
      const custom=await request(`${base}/r2/buckets/${options.bucketName}/domains/custom`);
      const subdomain=await request(`${base}/workers/subdomain`);
      const bindings=settings.bindings??[];
      const bound=(name,type)=>bindings.find(b=>b.name===name&&b.type===type);
      return {databaseName:db.name,actualDatabaseId:db.uuid,bucketName:bucket.name,
        databaseId:bound('DB','d1')?.id,boundBucket:bound('IMAGES','r2_bucket')?.bucket_name,
        origin:bound('TASK_BOARD_ORIGIN','plain_text')?.text,accountOrigin:`https://task-board.${subdomain.subdomain}.workers.dev`,
        readOnly:bound('TASK_BOARD_READ_ONLY','plain_text')?.text,
        privateBucket:managed.enabled===false&&Array.isArray(custom.domains)&&custom.domains.every(domain=>domain.enabled===false)};
    },
    async query(sql,params=[]) {
      const result=await request(`${base}/d1/database/${options.databaseId}/query`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sql,params})});
      if (!Array.isArray(result)||result.some(r=>r?.success!==true || r.results!==undefined&&!Array.isArray(r.results))) stop('remote_response');
      return result.flatMap(r=>r.results??[]);
    },
    getObject:key=>request(objectUrl(key),{},true,true),
    async putObject(key,bytes) {
      // Never knowingly replace an object. Destination application remains frozen.
      let response;
      try { response=await fetcher(objectUrl(key),{method:'PUT',redirect:'manual',headers:{Authorization:`Bearer ${options.apiToken}`,'Content-Type':'image/png','If-None-Match':'*','cf-r2-data-catalog-check':'true'},body:bytes,signal:AbortSignal.timeout(30000)}); }
      catch { stop('object_upload'); }
      if (response.redirected || response.url&&response.url!==objectUrl(key)||response.status>=300&&response.status<400) stop('remote_redirect');
      if (!response.ok&&response.status!==412) stop('object_upload');
      await response.body?.cancel();
    },
  };
}

/** Resumable only for the same v3 capture, owner and named frozen destination. */
export async function migrateCloudflare(options, dependencies={}) {
  const origin=configuration(options), plan=await prepareMigration(options.pages,options.owner);
  const remote=dependencies.remote??cloudflareTransport(options,dependencies.fetch);
  async function frozenTarget() {
    const state=await remote.inspect();
    if (state.databaseName!==options.databaseName || state.databaseId!==options.databaseId || state.actualDatabaseId!==options.databaseId || state.bucketName!==options.bucketName ||
        state.boundBucket!==options.bucketName || state.origin!==origin || state.accountOrigin!==origin || state.readOnly!=='true' || state.privateBucket!==true) stop('destination_not_frozen');
  }
  await frozenTarget();
  const query=remote.query.bind(remote), counts=JSON.stringify(plan.data.manifest.counts);
  await query('CREATE TABLE IF NOT EXISTS task_board_migration_state(owner TEXT PRIMARY KEY, backup_digest TEXT NOT NULL, owner_hash TEXT NOT NULL, state TEXT NOT NULL, counts_json TEXT NOT NULL)');
  let marker=(await query('SELECT * FROM task_board_migration_state WHERE owner=?',[plan.owner]))[0];
  if (marker&&(marker.backup_digest!==plan.digest||marker.owner_hash!==plan.ownerHash||marker.counts_json!==counts||!['pending','complete'].includes(marker.state))) stop('different_migration');
  const present=new Map();
  async function checkRows(complete=false) {
    for (const [table,columns] of Object.entries(tables)) {
      const actual=[];let after=0;
      for (;;) {
        const page=await query(`SELECT rowid AS migration_position,${columns.join(',')} FROM ${table} WHERE owner=? AND rowid>? ORDER BY rowid LIMIT 50`,[plan.owner,after]);
        if (!page.length) break;
        if (page.some(row=>!Number.isSafeInteger(row.migration_position)||row.migration_position<=after)) stop('remote_response');
        after=page.at(-1).migration_position;
        actual.push(...page.map(({migration_position,...row})=>row));
      }
      if (!marker&&actual.length) stop('destination_not_empty');
      const expected=new Map(plan.rows[table].map(r=>[r[keyColumn(table)],stable(r)]));
      if (actual.some(r=>expected.get(r[keyColumn(table)])!==stable(r))) stop('destination_record_conflict');
      // History rowids may change across installations; their relative event order must not.
      if (table.endsWith('_events')&&actual.some((r,i)=>stable(r)!==stable(plan.rows[table][i]))) stop('destination_history_conflict');
      if (complete&&stable(canonical(actual))!==stable(canonical(plan.rows[table]))) stop('destination_incomplete');
      present.set(table,new Set(actual.map(r=>r[keyColumn(table)])));
    }
  }
  await checkRows();
  if (!marker) {
    const empty=Object.keys(tables).map(t=>`NOT EXISTS(SELECT 1 FROM ${t} WHERE owner=?)`).join(' AND ');
    await query(`INSERT INTO task_board_migration_state(owner,backup_digest,owner_hash,state,counts_json) SELECT ?,?,?,'pending',? WHERE ${empty} ON CONFLICT(owner) DO NOTHING`,
      [plan.owner,plan.digest,plan.ownerHash,counts,...Object.keys(tables).map(()=>plan.owner)]);
    marker=(await query('SELECT * FROM task_board_migration_state WHERE owner=?',[plan.owner]))[0];
    if (!marker||marker.backup_digest!==plan.digest||marker.owner_hash!==plan.ownerHash||marker.counts_json!==counts) stop('different_migration');
  }
  await frozenTarget();
  for (const attachment of plan.rows.attachments) {
    await frozenTarget();
    let bytes=await remote.getObject(attachment.object_key);
    if (bytes===null) {
      await remote.putObject(attachment.object_key,plan.data.blobs.get(attachment.id));
      bytes=await remote.getObject(attachment.object_key);
    }
    if (!bytes||bytes.byteLength!==attachment.size||await hash(bytes)!==JSON.parse(attachment.payload).sha256) stop('destination_image_conflict');
  }
  if (marker.state!=='complete') {
    for (const [table,columns] of Object.entries(tables)) {
      await frozenTarget();
      const limit=Math.floor(90/columns.length), rows=plan.rows[table].filter(row=>!present.get(table).has(row[keyColumn(table)]));
      for (let i=0;i<rows.length;i+=limit) {
        await frozenTarget();
        const chunk=rows.slice(i,i+limit), values=chunk.map(()=>`(${columns.map(()=>'?').join(',')})`).join(',');
        await query(`INSERT INTO ${table}(${columns.join(',')}) VALUES ${values} ON CONFLICT(owner,${keyColumn(table)}) DO NOTHING`,chunk.flatMap(r=>columns.map(c=>r[c])));
      }
    }
  }
  await frozenTarget(); await checkRows(true); await frozenTarget();
  await query("UPDATE task_board_migration_state SET state='complete' WHERE owner=? AND backup_digest=? AND owner_hash=? AND counts_json=? AND state IN ('pending','complete')",[plan.owner,plan.digest,plan.ownerHash,counts]);
  const completed=(await query('SELECT * FROM task_board_migration_state WHERE owner=?',[plan.owner]))[0];
  if (!completed||completed.state!=='complete'||completed.backup_digest!==plan.digest||completed.owner_hash!==plan.ownerHash||completed.counts_json!==counts) stop('different_migration');
  await frozenTarget();
  return {complete:true,counts:plan.data.manifest.counts,backupDigest:plan.digest,origin,mcpUrl:origin+'/mcp',readOnly:true};
}

async function privateFile(filename,maxBytes) {
  if (typeof filename!=='string'||!path.isAbsolute(filename)) stop('private_file');
  const resolved=path.resolve(filename),parts=resolved.split(path.sep).filter(Boolean);
  if (parts.some(part=>['public','www','wwwroot','htdocs','static','dist','out'].includes(part.toLowerCase()))) stop('private_file');
  let file;
  try {
    let current=path.parse(resolved).root;
    for (let i=0;i<parts.length;i++) {
      current=path.join(current,parts[i]);const info=await lstat(current);
      if (info.isSymbolicLink()||i<parts.length-1&&!info.isDirectory()) stop('private_file');
      try { await lstat(path.join(current,'.git','HEAD')); stop('private_file'); } catch(e) { if(e.code!=='ENOENT'&&e.code!=='ENOTDIR')throw e; }
    }
    const info=await lstat(resolved);
    if (!info.isFile()||(info.mode&0o077)!==0||info.uid!==process.getuid?.()||info.size>maxBytes) stop('private_file');
    file=await open(resolved,constants.O_RDONLY|constants.O_NOFOLLOW);
    const opened=await file.stat();
    if (opened.dev!==info.dev||opened.ino!==info.ino||!opened.isFile()||(opened.mode&0o077)!==0||opened.uid!==process.getuid?.()||opened.size>maxBytes) stop('private_file');
    const value=await file.readFile('utf8');if(Buffer.byteLength(value)>maxBytes)stop('private_file');return value;
  } catch { stop('private_file'); }
  finally { await file?.close(); }
}
export async function migrationOptionsFromEnvironment(env=process.env) {
  let captured;try { captured=JSON.parse(await privateFile(env.TASK_BOARD_MIGRATION_FILE,512*1024*1024)); }
  catch(error) { if(error instanceof MigrationError)throw error;stop('invalid_capture'); }
  if (!!env.CLOUDFLARE_API_TOKEN===!!env.CLOUDFLARE_API_TOKEN_FILE) stop('credentials');
  const apiToken=env.CLOUDFLARE_API_TOKEN??(await privateFile(env.CLOUDFLARE_API_TOKEN_FILE,16384)).trim();
  return {pages:captured.pages??captured,owner:env.TASK_BOARD_STORAGE_OWNER,apiToken,
    accountId:env.CLOUDFLARE_ACCOUNT_ID,databaseId:env.TASK_BOARD_D1_DATABASE_ID,databaseName:env.TASK_BOARD_D1_DATABASE_NAME,
    bucketName:env.TASK_BOARD_R2_BUCKET_NAME,origin:env.TASK_BOARD_PRODUCTION_ORIGIN,approved:env.TASK_BOARD_MIGRATION_APPROVED==='true'};
}
if (process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length>2) stop('configuration');
    const result=await migrateCloudflare(await migrationOptionsFromEnvironment());
    console.log(JSON.stringify({complete:result.complete,counts:result.counts,mcpUrl:result.mcpUrl,readOnly:true}));
  } catch (error) { console.error(error instanceof MigrationError?error.message:'Migration stopped; no completion was recorded. Keep destination writes disabled.');process.exitCode=1; }
}
