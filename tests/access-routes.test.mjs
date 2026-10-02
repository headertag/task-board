import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { readAuthConfig } from '../lib/auth.ts';
import { readBrowserConfig, seal, SESSION_COOKIE, TRANSACTION_COOKIE } from '../lib/browser-auth.ts';
import { BoardService } from '../lib/service.ts';

// Production route/auth/storage code runs with fictional signed credentials,
// private sessions and SQLite. No fetch may reach a live service.
const origin = 'https://board.example.com', issuer = 'https://access-tests.example.authkit.app';
const owner = 'fictional-access-board-owner', otherOwner = 'fictional-other-board-owner';
const policy = {
  version: 1,
  owners: [
    { ownerId: owner, agentAccess: 'write', identities: [{ provider: 'google', email: 'admin@example.com', providerId: 'google-admin-pin', workosUserId: 'user_admin' }] },
    { ownerId: otherOwner, identities: [{ provider: 'google', email: 'other-admin@example.com', providerId: 'google-other-pin', workosUserId: 'user_other_admin' }] },
  ],
  clients: [{ clientId: 'fictional-read-client', access: 'read' }, { clientId: 'fictional-write-client', access: 'write', writeScope: 'tasks:write' }],
};
const initialUsers = {
  user_admin: { id: 'user_admin', email: 'admin@example.com', email_verified: true },
  user_other_admin: { id: 'user_other_admin', email: 'other-admin@example.com', email_verified: true },
  user_member: { id: 'user_member', email: 'member@example.com', email_verified: true },
  user_replacement: { id: 'user_replacement', email: 'member@example.com', email_verified: true },
  user_unknown: { id: 'user_unknown', email: 'unknown@example.com', email_verified: true },
};
const initialIdentities = {
  user_admin: [{ type: 'OAuth', provider: 'GoogleOAuth', idp_id: 'google-admin-pin' }],
  user_other_admin: [{ type: 'OAuth', provider: 'GoogleOAuth', idp_id: 'google-other-pin' }],
  user_member: [{ type: 'OAuth', provider: 'GoogleOAuth', idp_id: 'google-member-pin' }],
  user_replacement: [{ type: 'OAuth', provider: 'GoogleOAuth', idp_id: 'google-replacement-pin' }],
  user_unknown: [{ type: 'OAuth', provider: 'GoogleOAuth', idp_id: 'google-unknown-pin' }],
};
let sql, users, identities, task;
class Prepared {
  constructor(query, args = []) { this.query = query; this.args = args; }
  bind(...args) { return new Prepared(this.query, args); }
  async first() { return sql.prepare(this.query).get(...this.args) ?? null; }
  async all() { return { results: sql.prepare(this.query).all(...this.args) }; }
  async run() { const result = sql.prepare(this.query).run(...this.args); return { success: true, meta: { changes: Number(result.changes) } }; }
}
const db = {
  prepare: query => new Prepared(query),
  async batch(statements) {
    sql.exec('BEGIN');
    try {
      const results = statements.map(statement => /^\s*SELECT/i.test(statement.query)
        ? { results: sql.prepare(statement.query).all(...statement.args) }
        : { success: true, meta: { changes: Number(sql.prepare(statement.query).run(...statement.args).changes) } });
      sql.exec('COMMIT'); return results;
    } catch (error) { sql.exec('ROLLBACK'); throw error; }
  },
};
globalThis.__authRouteEnv = {
  DB: db, WORKOS_AUTHKIT_ISSUER: issuer, WORKOS_MCP_AUDIENCE: origin + '/mcp',
  WORKOS_API_KEY: 'fictional-workos-api-key', TASK_BOARD_AUTH_POLICY: JSON.stringify(policy),
  TASK_BOARD_ORIGIN: origin, WORKOS_BROWSER_CLIENT_ID: 'fictional-browser-client',
  TASK_BOARD_SESSION_SECRET: Buffer.alloc(32, 15).toString('base64url'), TASK_BOARD_READ_ONLY: 'false',
};
const { publicKey, privateKey } = await generateKeyPair('RS256');
const jwk = { ...await exportJWK(publicKey), kid: 'fictional-access-key', alg: 'RS256' };
const originalFetch = globalThis.fetch, requests = [], unexpected = [], codes = new Map();
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(input instanceof Request ? input.url : String(input)); requests.push(url.href);
  if (url.href === issuer + '/oauth2/jwks') return Response.json({ keys: [jwk] });
  if (url.href === issuer + '/oauth2/token') {
    assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'manual');
    const body = new URLSearchParams(String(options.body)), issued = codes.get(body.get('code')); assert.ok(issued); codes.delete(body.get('code'));
    const challenge = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body.get('code_verifier')))).toString('base64url');
    assert.equal(challenge, issued.challenge); assert.equal(body.get('client_id'), 'fictional-browser-client'); assert.equal(body.get('redirect_uri'), origin + '/auth/callback');
    return Response.json({ id_token: await token(issued.subject, { aud: 'fictional-browser-client', nonce: issued.nonce, client_id: undefined, sid: undefined, scope: undefined }) });
  }
  const match = /^\/user_management\/users\/([^/]+)(\/identities)?$/.exec(url.pathname);
  if (url.origin === 'https://api.workos.com' && match && !url.search) {
    assert.equal(new Headers(options.headers).get('authorization'), 'Bearer fictional-workos-api-key');
    assert.equal(options.redirect, 'manual');
    const subject = decodeURIComponent(match[1]);
    return Response.json((match[2] ? identities : users)[subject] ?? {}, { status: users[subject] ? 200 : 404 });
  }
  unexpected.push(url.href); throw new Error('Unexpected network request in fictional access test');
};
const access = await import('../app/api/access/route.ts');
const board = await import('../app/api/board/route.ts');
const mcp = await import('../app/mcp/route.ts');
const signin = await import('../app/auth/signin/route.ts');
const callback = await import('../app/auth/callback/route.ts');
const { AccessStore } = await import('../lib/access.ts');

beforeEach(async () => {
  sql?.close(); sql = new DatabaseSync(':memory:');
  for (const file of readdirSync('drizzle').filter(file => file.endsWith('.sql')).sort()) sql.exec(readFileSync('drizzle/' + file, 'utf8'));
  users = structuredClone(initialUsers); identities = structuredClone(initialIdentities); requests.length = 0; codes.clear();
  globalThis.__authRouteEnv.TASK_BOARD_AUTH_POLICY = JSON.stringify(policy); globalThis.__authRouteEnv.TASK_BOARD_READ_ONLY = 'false';
  task = await new BoardService(db, owner).mutate('create', { task: { title: 'Fictional existing private task' }, requestKey: 'fictional-existing-create' });
});
after(() => { sql?.close(); globalThis.fetch = originalFetch; delete globalThis.__authRouteEnv; assert.deepEqual(unexpected, []); });

function request(path, method = 'GET', value, headers = {}) {
  return new Request(origin + path, { method, headers: { ...(value === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, ...(value === undefined ? {} : { body: typeof value === 'string' ? value : JSON.stringify(value) }) });
}
async function session(subject = 'user_admin') {
  const config = readBrowserConfig(globalThis.__authRouteEnv, readAuthConfig(globalThis.__authRouteEnv));
  const cookie = await seal({ sub: subject, issuer, audience: config.clientId, expiresAt: Math.floor(Date.now() / 1000) + 1800 }, 'session', config);
  return { cookie: SESSION_COOKIE + '=' + cookie };
}
async function token(subject = 'user_admin', patch = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ iss: issuer, aud: origin + '/mcp', sub: subject, iat: now - 30, exp: now + 600, client_id: 'fictional-dynamic-client', sid: 'fictional-owner-consent', scope: 'openid profile email', ...patch }).setProtectedHeader({ alg: 'RS256', kid: jwk.kid }).sign(privateKey);
}
async function allow(email = 'member@example.com', role = 'write') {
  const response = await access.POST(request('/api/access', 'POST', { action: 'allow', email, access: role }, { ...await session(), origin }));
  assert.equal(response.status, 200); return response.json();
}
async function api(name, args = {}, headers = {}) { return board.POST(request('/api/board', 'POST', { name, args }, headers)); }
async function rpc(method, params, subject = 'user_member', patch = {}) {
  return mcp.POST(request('/mcp', 'POST', { jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }, { authorization: 'Bearer ' + await token(subject, patch) }));
}
async function denied(response, status, code) {
  assert.equal(response.status, status); if (code) assert.equal((await response.json()).error, code); assert.match(response.headers.get('cache-control'), /no-store/);
}
async function memberAccess(subject = 'user_member') { return api('list_tasks', {}, await session(subject)); }
async function signInMember(subject = 'user_member') {
  const started = await signin.GET(request('/auth/signin', 'GET')); assert.equal(started.status, 302); const authorize = new URL(started.headers.get('location'));
  const transaction = started.headers.getSetCookie().find(value => value.startsWith(TRANSACTION_COOKIE + '=')).split(';')[0];
  const code = 'fictional-login-' + crypto.randomUUID(); codes.set(code, { subject, challenge: authorize.searchParams.get('code_challenge'), nonce: authorize.searchParams.get('nonce') });
  return callback.GET(request('/auth/callback?' + new URLSearchParams({ code, state: authorize.searchParams.get('state') }), 'GET', undefined, { cookie: transaction }));
}

test('anonymous and forged headers fail before body parsing or identity lookup for every access verb', async () => {
  for (const method of ['GET', 'POST', 'HEAD', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) await denied(await access[method](request('/api/access', method, method === 'POST' ? 'malformed' : undefined)), 401);
  await denied(await access.GET(request('/api/access', 'GET', undefined, { 'x-user-id': owner, 'cf-access-authenticated-user-email': 'admin@example.com' })), 401); assert.equal(requests.length, 0);
});

test('fully pinned static owner lists safe bootstrap metadata and allows normalized read/write members', async () => {
  const first = await access.GET(request('/api/access', 'GET', undefined, await session())); assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { members: [{ email: 'admin@example.com', access: 'write', active: true, bound: true, bootstrap: true }] });
  const result = await allow('  MEMBER@example.com  ', 'read'); assert.deepEqual(result.members.find(member => member.email === 'member@example.com'), { email: 'member@example.com', access: 'read', active: true, bound: false });
  await allow('member@example.com', 'write'); const changed = await access.GET(request('/api/access', 'GET', undefined, await session()));
  assert.equal((await changed.json()).members.find(member => member.email === 'member@example.com').access, 'write');
  const memberResponse = await memberAccess(); assert.equal(memberResponse.status, 200); assert.deepEqual((await memberResponse.json()).tasks.map(item => item.id), [task.id]);
  const bound = await access.GET(request('/api/access', 'GET', undefined, await session())); const json = await bound.json(); assert.equal(json.members.find(member => member.email === 'member@example.com').bound, true);
  for (const member of json.members) assert.ok(Object.keys(member).every(key => ['email', 'access', 'active', 'bound', 'bootstrap'].includes(key)));
  for (const privateValue of [owner, otherOwner, 'user_admin', 'user_member', 'google-admin-pin', 'google-member-pin']) assert.equal(JSON.stringify(json).includes(privateValue), false);
});

test('bearer owners, unapproved sessions, dynamic invitees and incompletely pinned static identities cannot manage', async () => {
  await denied(await access.GET(request('/api/access', 'GET', undefined, { authorization: 'Bearer ' + await token() })), 403);
  await denied(await access.GET(request('/api/access', 'GET', undefined, await session('user_unknown'))), 403);
  await allow(); assert.equal((await memberAccess()).status, 200);
  for (const method of ['GET', 'POST']) await denied(await access[method](request('/api/access', method, method === 'POST' ? { action: 'allow', email: 'unknown@example.com', access: 'write' } : undefined, { ...await session('user_member'), origin })), 403, 'access_management_denied');
  const weak = structuredClone(policy); delete weak.owners[0].identities[0].workosUserId; delete weak.owners[0].agentAccess; globalThis.__authRouteEnv.TASK_BOARD_AUTH_POLICY = JSON.stringify(weak);
  assert.equal((await api('list_tasks', {}, await session())).status, 200); await denied(await access.GET(request('/api/access', 'GET', undefined, await session())), 403, 'access_management_denied');
});

test('management mutations require exact same-origin browser proof and freeze cannot be bypassed', async () => {
  const cookie = await session(), body = { action: 'allow', email: 'member@example.com', access: 'write' };
  for (const headers of [cookie, { ...cookie, origin: 'null' }, { ...cookie, origin: 'https://evil.example' }, { ...cookie, origin, 'sec-fetch-site': 'cross-site' }]) await denied(await access.POST(request('/api/access', 'POST', body, headers)), 403, 'origin_mismatch');
  await denied(await access.GET(request('/api/access', 'GET', undefined, { ...cookie, origin: 'https://evil.example' })), 403, 'origin_mismatch');
  globalThis.__authRouteEnv.TASK_BOARD_READ_ONLY = 'true'; await denied(await access.POST(request('/api/access', 'POST', body, { ...cookie, origin })), 403, 'permission_denied');
  assert.equal((await new AccessStore(db).list(owner)).length, 0);
});

test('invalid/oversized input and bootstrap changes never modify access or task records', async () => {
  const headers = { ...await session(), origin }, before = sql.prepare('SELECT * FROM tasks').all();
  for (const body of [null, [], { action: 'allow', email: 'member@example.com', access: 'admin' }, { action: 'allow', email: 'member@example.com', access: 'write', ownerId: otherOwner }, { action: 'revoke', email: 'member@example.com', access: 'write' }, 'malformed']) await denied(await access.POST(request('/api/access', 'POST', body, headers)), 400);
  for (const email of ['not-an-email', 'a@example.com\nInjected', 'a'.repeat(321) + '@example.com']) await denied(await access.POST(request('/api/access', 'POST', { action: 'allow', email, access: 'read' }, headers)), 400);
  for (const action of ['allow', 'revoke']) for (const email of ['admin@example.com', 'OTHER-ADMIN@example.com']) await denied(await access.POST(request('/api/access', 'POST', { action, email, ...(action === 'allow' ? { access: 'write' } : {}) }, headers)), 400, 'bootstrap_access_protected');
  await denied(await access.POST(request('/api/access', 'POST', 'x'.repeat(4097), headers)), 413);
  await denied(await access.POST(request('/api/access', 'POST', {}, { ...headers, 'content-type': 'text/plain' })), 415);
  assert.deepEqual(await new AccessStore(db).list(owner), []); assert.deepEqual(sql.prepare('SELECT * FROM tasks').all(), before);
});

test('first member authentication requires authoritative verified email and one Google identity', async () => {
  await allow(); const original = structuredClone(identities.user_member);
  users.user_member.email_verified = false; await denied(await memberAccess(), 403); users.user_member.email_verified = true;
  for (const social of [[], [{ type: 'OAuth', provider: 'GithubOAuth', idp_id: 'github-member' }], [...original, { type: 'OAuth', provider: 'GoogleOAuth', idp_id: 'google-second-pin' }]]) { identities.user_member = social; await denied(await memberAccess(), 403); assert.equal((await new AccessStore(db).list(owner))[0].bound, false); }
  identities.user_member = original; assert.equal((await memberAccess()).status, 200); assert.equal((await new AccessStore(db).list(owner))[0].bound, true);
});

test('real PKCE/nonce callback applies membership before issuing a browser session and pins only verified Google login', async () => {
  await allow(); users.user_member.email_verified = false; const refused = await signInMember(); await denied(refused, 403);
  assert.equal(refused.headers.getSetCookie().some(value => value.startsWith(SESSION_COOKIE + '=')), false); assert.equal((await new AccessStore(db).list(owner))[0].bound, false);
  users.user_member.email_verified = true; const admitted = await signInMember(); assert.equal(admitted.status, 303);
  const cookie = admitted.headers.getSetCookie().find(value => value.startsWith(SESSION_COOKIE + '=')).split(';')[0];
  assert.equal((await new AccessStore(db).list(owner))[0].bound, true); const response = await api('list_tasks', {}, { cookie }); assert.equal(response.status, 200); assert.deepEqual((await response.json()).tasks.map(item => item.id), [task.id]);
});

test('pinned member rejects replacement WorkOS/provider IDs and a changed verified email on subsequent sealed sessions', async () => {
  await allow(); const cookie = await session('user_member'); assert.equal((await api('list_tasks', {}, cookie)).status, 200);
  await denied(await memberAccess('user_replacement'), 403); identities.user_member[0].idp_id = 'google-changed-pin'; await denied(await api('list_tasks', {}, cookie), 403);
  identities.user_member = structuredClone(initialIdentities.user_member); users.user_member.email = 'different@example.com'; await denied(await api('list_tasks', {}, cookie), 403);
});

test('read membership caps browser, registered-write and consented dynamic MCP rights; explicit client-read and freeze cap write members', async () => {
  await allow('member@example.com', 'read'); const cookie = { ...await session('user_member'), origin }; assert.equal((await memberAccess()).status, 200);
  const create = { task: { title: 'Fictional rejected member mutation' }, requestKey: 'fictional-member-write' };
  await denied(await api('create_task', create, cookie), 403, 'permission_denied');
  for (const claims of [{}, { client_id: 'fictional-write-client', scope: 'openid profile email tasks:write' }]) await denied(await rpc('tools/call', { name: 'create_task', arguments: create }, 'user_member', claims), 403, 'permission_denied');
  const listed = await rpc('tools/list'); assert.equal(listed.status, 200); assert.equal((await listed.json()).result.tools.some(tool => tool.name === 'create_task'), false);
  await allow(); await denied(await rpc('tools/call', { name: 'create_task', arguments: create }, 'user_member', { client_id: 'fictional-read-client' }), 403, 'permission_denied');
  const written = await rpc('tools/call', { name: 'create_task', arguments: create }); assert.equal(written.status, 200); assert.equal((await written.json()).result.isError, false);
  globalThis.__authRouteEnv.TASK_BOARD_READ_ONLY = 'true'; await denied(await rpc('tools/call', { name: 'create_task', arguments: { ...create, requestKey: 'fictional-frozen-member' } }), 403, 'permission_denied');
});

test('soft revocation blocks existing browser and MCP credentials immediately and re-allow preserves original pins', async () => {
  await allow(); const memberCookie = await session('user_member'), memberToken = await token('user_member'); assert.equal((await api('list_tasks', {}, memberCookie)).status, 200);
  const response = await access.POST(request('/api/access', 'POST', { action: 'revoke', email: 'member@example.com' }, { ...await session(), origin })); assert.equal(response.status, 200);
  const member = (await response.json()).members.find(member => member.email === 'member@example.com'); assert.equal(member.active, false); assert.equal(member.bound, true);
  await denied(await api('list_tasks', {}, memberCookie), 403); await denied(await mcp.POST(request('/mcp', 'POST', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { authorization: 'Bearer ' + memberToken })), 403);
  await allow('member@example.com', 'read'); await denied(await memberAccess('user_replacement'), 403); assert.equal((await api('list_tasks', {}, memberCookie)).status, 200);
});

test('competing first verified Google subjects bind one immutable pair and cannot grant both access', async () => {
  await allow(); const results = await Promise.all([memberAccess('user_member'), memberAccess('user_replacement')]); assert.deepEqual(results.map(response => response.status).sort(), [200, 403]);
  const winning = results[0].status === 200 ? 'user_member' : 'user_replacement', losing = winning === 'user_member' ? 'user_replacement' : 'user_member';
  assert.equal((await memberAccess(winning)).status, 200); await denied(await memberAccess(losing), 403); assert.equal((await new AccessStore(db).list(owner))[0].bound, true);
});

test('ambiguous membership across configured boards fails closed before first identity pinning', async () => {
  await allow(); await new AccessStore(db).allow({ ownerId: otherOwner, email: 'member@example.com', access: 'write', actorWorkosUserId: 'user_other_admin' });
  await denied(await memberAccess(), 403); assert.equal((await new AccessStore(db).list(owner))[0].bound, false); assert.equal((await new AccessStore(db).list(otherOwner))[0].bound, false);
});

test('static Google alias that also matches a different invited board fails ambiguity without pinning', async () => {
  await new AccessStore(db).allow({ ownerId: otherOwner, email: 'admin@example.com', access: 'write', actorWorkosUserId: 'user_other_admin' });
  await denied(await access.GET(request('/api/access', 'GET', undefined, await session())), 403); assert.equal((await new AccessStore(db).list(otherOwner))[0].bound, false);
});
