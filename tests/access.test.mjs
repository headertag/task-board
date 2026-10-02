import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {generateKeyPair,exportJWK,createLocalJWKSet,SignJWT} from 'jose';
import {AccessStore,normalizeAccessEmail} from '../lib/access.ts';
import {authorizeWorkosUser,authenticateBearer,readAuthConfig} from '../lib/auth.ts';

// No real addresses, identity IDs, credentials, browser cookies or network.
const issuer='https://synthetic.authkit.app',audience='https://synthetic.example/mcp',currentDate=new Date('2026-10-02T00:00:00Z'),now=currentDate.getTime()/1000;
const pair=await generateKeyPair('RS256'),key=createLocalJWKSet({keys:[{...await exportJWK(pair.publicKey),kid:'synthetic-access',alg:'RS256'}]});
function config(agentAccess='write') {return readAuthConfig({WORKOS_AUTHKIT_ISSUER:issuer,WORKOS_MCP_AUDIENCE:audience,WORKOS_API_KEY:'synthetic-key',TASK_BOARD_AUTH_POLICY:JSON.stringify({version:1,owners:[
 {ownerId:'synthetic-owner-a',agentAccess,identities:[{provider:'google',email:'admin@example.com',providerId:'google_admin',workosUserId:'user_admin'}]},
 {ownerId:'synthetic-owner-b',agentAccess,identities:[{provider:'google',email:'owner-b@example.com',providerId:'google_b',workosUserId:'user_owner_b'}]},
 ],clients:[{clientId:'read-client',access:'read'},{clientId:'write-client',access:'write',writeScope:'tasks:write'}]})})}
function fixture(t) {
 const sql=new DatabaseSync(':memory:');for(const file of readdirSync('drizzle').filter(f=>f.endsWith('.sql')).sort())sql.exec(readFileSync('drizzle/'+file,'utf8'));t.after(()=>sql.close());
 // D1 batch executes each complete transaction serially. Keep the SQLite
 // transaction synchronous while simultaneous authentication reads still race.
 const db={prepare(query){return {bind(...args){return {query,args,first:async()=>sql.prepare(query).get(...args)??null,all:async()=>({results:sql.prepare(query).all(...args)}),run:async()=>sql.prepare(query).run(...args)}}}},async batch(statements){sql.exec('BEGIN');try{const out=statements.map(statement=>sql.prepare(statement.query).run(...statement.args));sql.exec('COMMIT');return out}catch(error){sql.exec('ROLLBACK');throw error}}};
 const store=new AccessStore(db),users={user_admin:{id:'user_admin',email:'admin@example.com',email_verified:true},user_invited:{id:'user_invited',email:'Invited@Example.com',email_verified:true},user_replacement:{id:'user_replacement',email:'invited@example.com',email_verified:true}},identities={user_admin:[{type:'OAuth',provider:'GoogleOAuth',idp_id:'google_admin'}],user_invited:[{type:'OAuth',provider:'GoogleOAuth',idp_id:'google_invited'}],user_replacement:[{type:'OAuth',provider:'GoogleOAuth',idp_id:'google_replacement'}]};
 const deps={key,currentDate,accessStore:store,fetch:async(url,init)=>{assert.equal(init.redirect,'manual');assert.equal(init.headers.Authorization,'Bearer synthetic-key');const m=/^https:\/\/api\.workos\.com\/user_management\/users\/(user_[A-Za-z0-9_-]+)(\/identities)?$/.exec(url);assert.ok(m);return Response.json((m[2]?identities:users)[m[1]]??{}, {status:users[m[1]]?200:404})}};
 const allow=(access='write',email='invited@example.com',ownerId='synthetic-owner-a')=>store.allow({ownerId,email,access,actorWorkosUserId:'user_admin'});
 const browser=(subject='user_invited',policy=config())=>authorizeWorkosUser(subject,policy,{kind:'browser'},deps);
 const row=()=>sql.prepare('SELECT * FROM access_grants WHERE owner=? AND email=?').get('synthetic-owner-a','invited@example.com');
 return {sql,db,store,users,identities,deps,allow,browser,row};
}
const denied=error=>error.status===403&&error.code==='identity_not_allowed';
async function connect(f,clientId='dynamic-client',scope='openid profile email',policy=config(),patch={}) {
 const token=await new SignJWT({iss:issuer,aud:audience,sub:'user_invited',iat:now-10,exp:now+300,client_id:clientId,sid:'synthetic-consent',scope,...patch}).setProtectedHeader({alg:'RS256',kid:'synthetic-access'}).sign(pair.privateKey);
 return authenticateBearer(new Headers({authorization:'Bearer '+token}),policy,f.deps);
}

test('manual allow is normalized; first verified Google login pins both IDs atomically with attributed audit',async t=>{
 const f=fixture(t);await f.allow('write',' Invited@Example.COM ');
 assert.deepEqual(await f.store.list('synthetic-owner-a'),[{email:'invited@example.com',access:'write',active:true,bound:false}]);
 const principal=await f.browser();assert.equal(principal.ownerId,'synthetic-owner-a');assert.equal(principal.canWrite,true);assert.equal(principal.canManageAccess,false);
 const bound=f.row();assert.equal(bound.google_provider_id,'google_invited');assert.equal(bound.workos_user_id,'user_invited');assert.equal(bound.version,2);
 assert.deepEqual(f.sql.prepare('SELECT action,actor_user_id FROM access_events ORDER BY rowid').all().map(row=>({...row})),[{action:'allow',actor_user_id:'user_admin'},{action:'bind',actor_user_id:'user_invited'}]);
 await f.browser();assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM access_events').get().n,2);
 const safe=JSON.stringify(await f.store.list('synthetic-owner-a'));assert.equal(safe.includes('google_invited'),false);assert.equal(safe.includes('user_invited'),false);assert.equal(safe.includes('synthetic-owner-a'),false);
});

test('dynamic roles cap browser and signed client rights; only pinned static Google browsers manage access',async t=>{
 const f=fixture(t);await f.allow('read');assert.equal((await f.browser()).canWrite,false);
 assert.equal((await connect(f,'write-client','tasks:write')).canWrite,false);
 await f.allow('write');assert.equal((await f.browser()).canWrite,true);
 assert.equal((await connect(f)).canWrite,true);assert.equal((await connect(f)).canManageAccess,false);
 assert.equal((await connect(f,'read-client','tasks:write')).canWrite,false);
 assert.equal((await connect(f,'write-client')).canWrite,false);assert.equal((await connect(f,'write-client','tasks:write')).canWrite,true);
 assert.equal((await connect(f,'write-client','tasks:write-extra')).canWrite,false);assert.equal((await connect(f,'dynamic-client','openid',config('read'))).canWrite,false);
 assert.equal((await f.browser('user_admin')).canManageAccess,true);
 const incomplete=config('read');delete incomplete.policy.owners[0].identities[0].workosUserId;
 assert.equal((await f.browser('user_admin',incomplete)).canManageAccess,false);
});

test('unverified email, absent/ambiguous Google identity and mutable email aliases never bind',async t=>{
 for(const change of [f=>f.users.user_invited.email_verified=false,f=>f.users.user_invited.email='different@example.com',f=>f.identities.user_invited=[],f=>f.identities.user_invited=[{type:'OAuth',provider:'GithubOAuth',idp_id:'github_only'}],f=>f.identities.user_invited.push({type:'OAuth',provider:'GoogleOAuth',idp_id:'google_second'})]){
  const f=fixture(t);await f.allow();change(f);await assert.rejects(f.browser,denied);assert.equal(f.row().google_provider_id,null);assert.equal(f.row().workos_user_id,null);assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM access_events WHERE action='bind'").get().n,0);
 }
});

test('simultaneous first logins bind one complete identity pair and refuse the competing account',async t=>{
 const f=fixture(t);await f.allow();const results=await Promise.allSettled([f.browser(),f.browser('user_replacement')]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected'&&denied(r.reason)).length,1);
 const winner=results.find(r=>r.status==='fulfilled').value.workosUserId,stored=f.row();assert.equal(stored.workos_user_id,winner);assert.equal(stored.google_provider_id,f.identities[winner][0].idp_id);
 assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM access_events WHERE action='bind'").get().n,1);
});

test('pins survive revocation, re-enabling and role changes; same email cannot replace either immutable ID',async t=>{
 const f=fixture(t);await f.allow();await f.browser();const pins=f.row();
 f.identities.user_invited[0].idp_id='google_changed';await assert.rejects(f.browser,denied);f.identities.user_invited[0].idp_id=pins.google_provider_id;
 f.identities.user_replacement[0].idp_id=pins.google_provider_id;await assert.rejects(()=>f.browser('user_replacement'),denied);
 await f.store.revoke({ownerId:'synthetic-owner-a',email:'invited@example.com',actorWorkosUserId:'user_admin'});await assert.rejects(f.browser,denied);assert.equal(f.row().active,0);
 await f.allow('read');assert.equal(f.row().google_provider_id,pins.google_provider_id);assert.equal(f.row().workos_user_id,pins.workos_user_id);assert.equal((await f.browser()).canWrite,false);await assert.rejects(()=>f.browser('user_replacement'),denied);
 assert.deepEqual(await f.store.list('synthetic-owner-b'),[]);
});

test('overlapping dynamic or static owner matches fail closed before any first pin',async t=>{
 const f=fixture(t);await f.allow();await f.allow('write','invited@example.com','synthetic-owner-b');await assert.rejects(f.browser,denied);
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM access_grants WHERE google_provider_id IS NOT NULL').get().n,0);
 await f.allow('write','admin@example.com','synthetic-owner-b');await assert.rejects(()=>f.browser('user_admin'),denied);
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM access_grants WHERE google_provider_id IS NOT NULL').get().n,0);
});

test('revoke and role-change races invalidate unbound snapshots instead of repinning stale grants',async t=>{
 const f=fixture(t);await f.allow();const original=(await f.store.find('invited@example.com',['synthetic-owner-a']))[0];
 await f.store.revoke({ownerId:'synthetic-owner-a',email:original.email,actorWorkosUserId:'user_admin'});
 assert.equal(await f.store.pin(original,{providerId:'google_invited',workosUserId:'user_invited'}),null);assert.equal(f.row().google_provider_id,null);
 await f.allow('read');assert.equal(await f.store.pin(original,{providerId:'google_invited',workosUserId:'user_invited'}),null);assert.equal(f.row().google_provider_id,null);
 assert.equal((await f.browser()).canWrite,false);assert.equal(f.row().google_provider_id,'google_invited');
});

test('invalid signed token cannot bind an invitation; unavailable access storage cannot authorize',async t=>{
 const f=fixture(t);await f.allow();for(const patch of [{aud:'https://other.example/mcp'},{sid:undefined},{exp:now-1},{act:{sub:'actor'}}])await assert.rejects(()=>connect(f,'dynamic-client','openid',config(),patch),error=>error.status===401);
 for(const context of [{kind:'connect',clientId:'',consentId:'valid',scopes:[]},{kind:'connect',clientId:'valid',consentId:'',scopes:[]}])await assert.rejects(()=>authorizeWorkosUser('user_invited',config(),context,f.deps),error=>error.status===401);
 assert.equal(f.row().google_provider_id,null);
 const broken=new AccessStore({prepare(){throw new Error('private database details')}});await assert.rejects(()=>authorizeWorkosUser('user_invited',config(),{kind:'browser'},{...f.deps,accessStore:broken}),error=>error.status===503&&error.code==='access_unavailable'&&!error.message.includes('private database'));
 for(const email of ['bad','double@@example.com','a b@example.com','a\nb@example.com','x@example.com\u0000'])assert.throws(()=>normalizeAccessEmail(email),error=>error.status===400);
});
