import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { BoardService } from '../lib/service.ts';
import { crc32, normalizePng } from '../lib/image.ts';
import { SESSION_COOKIE, TRANSACTION_COOKIE } from '../lib/browser-auth.ts';

// All identities, hosts, credentials, and records in this suite are fictional.
// Fetch is fail-closed and never delegates to the network.
const origin = 'https://board.example.com';
const issuer = 'https://auth.example.authkit.app';
const audience = origin + '/mcp';
const browserClient = 'synthetic-browser-client';
const ownerA = 'legacy-owner-synthetic-a';
const ownerB = 'synthetic-owner-b';
const policy = {
  version: 1,
  owners: [
    { ownerId: ownerA, identities: [{ provider: 'google', email: 'owner-a@example.com', providerId: 'google-stable-101' }] },
    { ownerId: ownerB, identities: [{ provider: 'github', providerId: 'github-stable-202' }] },
  ],
  clients: [
    { clientId: 'synthetic-read-client', access: 'read' },
    // This is a synthetic explicitly registered custom-scope client. It does
    // not assume WorkOS DCR/CIMD clients receive custom task scopes.
    { clientId: 'synthetic-write-client', access: 'write', writeScope: 'tasks:write' },
  ],
};
function delegatedPolicy() {
  return { ...structuredClone(policy), owners: policy.owners.map(owner => owner.ownerId === ownerA
    ? { ...owner, agentAccess: 'write', identities: owner.identities.map(identity => ({ ...identity, workosUserId: 'user_synthetic_a' })) }
    : structuredClone(owner)) };
}
const originalUsers = {
  user_synthetic_a: { id: 'user_synthetic_a', email: 'owner-a@example.com', email_verified: true, name: 'Synthetic Owner A' },
  user_synthetic_b: { id: 'user_synthetic_b', email: 'owner-b@example.com', email_verified: true, name: 'Synthetic Owner B' },
  user_unapproved: { id: 'user_unapproved', email: 'unapproved@example.com', email_verified: true },
};
const originalIdentities = {
  user_synthetic_a: [{ type: 'OAuth', provider: 'GoogleOAuth', idp_id: 'google-stable-101' }],
  user_synthetic_b: [{ type: 'OAuth', provider: 'GithubOAuth', idp_id: 'github-stable-202' }],
  user_unapproved: [{ type: 'OAuth', provider: 'GoogleOAuth', idp_id: 'google-stable-303' }],
};
let users = structuredClone(originalUsers);
let identities = structuredClone(originalIdentities);
const requests = [];
const unexpectedFetches = [];
const codes = new Map();
const { publicKey, privateKey } = await generateKeyPair('RS256');
const wrongKey = (await generateKeyPair('RS256')).privateKey;
const jwk = { ...await exportJWK(publicKey), kid: 'synthetic-route-key', alg: 'RS256' };

async function token(patch = {}, signingKey = privateKey, algorithm = 'RS256') {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: issuer, aud: audience, sub: 'user_synthetic_a', iat: now - 60, exp: now + 600,
    client_id: 'synthetic-read-client', sid: 'synthetic-opaque-consent', scope: 'openid profile email',
    ...patch,
  };
  for (const key of Object.keys(claims)) if (claims[key] === undefined) delete claims[key];
  return new SignJWT(claims).setProtectedHeader({ alg: algorithm, kid: jwk.kid }).sign(signingKey);
}

const sqlite = new DatabaseSync(':memory:');
for (const file of readdirSync('drizzle').filter(file => file.endsWith('.sql')).sort()) {
  sqlite.exec(readFileSync('drizzle/' + file, 'utf8'));
}
class Prepared {
  constructor(query, args = []) { this.query = query; this.args = args; }
  bind(...args) { return new Prepared(this.query, args); }
  async first() { return sqlite.prepare(this.query).get(...this.args) ?? null; }
  async all() { return { results: sqlite.prepare(this.query).all(...this.args) }; }
  async run() {
    const result = sqlite.prepare(this.query).run(...this.args);
    return { success: true, meta: { changes: Number(result.changes) } };
  }
}
const db = {
  prepare: query => new Prepared(query),
  async batch(statements) {
    sqlite.exec('BEGIN');
    try {
      const result = statements.map(statement => /^\s*SELECT/i.test(statement.query)
        ? { results: sqlite.prepare(statement.query).all(...statement.args) }
        : { success: true, meta: { changes: Number(sqlite.prepare(statement.query).run(...statement.args).changes) } });
      sqlite.exec('COMMIT');
      return result;
    } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  },
};
const objects = new Map();
const r2 = {
  async put(key, bytes, options) {
    if (objects.has(key) && options?.onlyIf?.etagDoesNotMatch === '*') return null;
    objects.set(key, new Uint8Array(bytes));
    return { key };
  },
  async get(key, options) {
    const bytes = objects.get(key);
    if (!bytes) return null;
    const result = options?.range ? bytes.slice(options.range.offset, options.range.offset + options.range.length) : bytes;
    return { arrayBuffer: async () => result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength), body: new Blob([result]).stream() };
  },
};
globalThis.__authRouteEnv = {
  DB: db, IMAGES: r2,
  WORKOS_AUTHKIT_ISSUER: issuer, WORKOS_MCP_AUDIENCE: audience,
  WORKOS_API_KEY: 'synthetic-api-key', TASK_BOARD_AUTH_POLICY: JSON.stringify(policy),
  TASK_BOARD_ORIGIN: origin, WORKOS_BROWSER_CLIENT_ID: browserClient,
  TASK_BOARD_SESSION_SECRET: Buffer.alloc(32, 7).toString('base64url'),
  TASK_BOARD_READ_ONLY: 'false',
};
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const headers = new Headers(options.headers);
  requests.push({ url: url.href, method: options.method || 'GET' });
  if (url.href === issuer + '/oauth2/jwks') {
    assert.equal(headers.has('authorization'), false);
    return Response.json({ keys: [jwk] });
  }
  if (url.href === issuer + '/oauth2/token') {
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'manual');
    const body = new URLSearchParams(String(options.body));
    const grant = codes.get(body.get('code'));
    assert.ok(grant, 'Only a previously issued synthetic authorization code is exchanged');
    codes.delete(body.get('code'));
    assert.equal(body.get('grant_type'), 'authorization_code');
    assert.equal(body.get('client_id'), browserClient);
    assert.equal(body.get('redirect_uri'), origin + '/auth/callback');
    assert.equal(body.get('resource'), audience);
    const challenge = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body.get('code_verifier')))).toString('base64url');
    assert.equal(challenge, grant.challenge, 'The token exchange proves the original S256 PKCE verifier');
    const response = Response.json({ id_token: await token({
      sub: grant.subject, aud: browserClient, nonce: grant.nonce,
      client_id: undefined, sid: undefined, scope: undefined, ...grant.idClaims,
    }) });
    return grant.tokenResponse ? grant.tokenResponse(response) : response;
  }
  if (url.origin === issuer && ['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration'].includes(url.pathname)) {
    return Response.json({
      issuer, authorization_endpoint: issuer + '/oauth2/authorize', token_endpoint: issuer + '/oauth2/token',
      jwks_uri: issuer + '/oauth2/jwks', response_types_supported: ['code'],
      code_challenge_methods_supported: ['S256'], grant_types_supported: ['authorization_code', 'refresh_token'],
    });
  }
  const match = /^\/user_management\/users\/([^/]+)(\/identities)?$/.exec(url.pathname);
  if (url.origin === 'https://api.workos.com' && match && !url.search) {
    assert.equal(headers.get('authorization'), 'Bearer synthetic-api-key');
    assert.equal(options.redirect, 'manual');
    const subject = decodeURIComponent(match[1]);
    return Response.json((match[2] ? identities : users)[subject] ?? {}, { status: users[subject] ? 200 : 404 });
  }
  unexpectedFetches.push(url.href);
  throw new Error('Unexpected fetch in synthetic route test');
};

// Dynamic imports ensure platform bindings and the bounded fake provider are
// installed before importing real production routes.
const mcp = await import('../app/mcp/route.ts');
const board = await import('../app/api/board/route.ts');
const images = await import('../app/api/images/route.ts');
const signin = await import('../app/auth/signin/route.ts');
const callback = await import('../app/auth/callback/route.ts');
const { oauthDiscovery } = await import('../build/oauth-discovery.ts');
const { getBoardPrincipal, requireBoardPrincipal } = await import('../app/authentication.ts');

function chunk(type, data) {
  const output = new Uint8Array(data.length + 12), view = new DataView(output.buffer);
  view.setUint32(0, data.length); output.set(new TextEncoder().encode(type), 4); output.set(data, 8);
  view.setUint32(output.length - 4, crc32(output.subarray(4, output.length - 4)));
  return output;
}
const imageHeader = new Uint8Array(13), imageView = new DataView(imageHeader.buffer);
imageView.setUint32(0, 1); imageView.setUint32(4, 1); imageHeader[8] = 8; imageHeader[9] = 6;
const png = new Uint8Array(Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', imageHeader),
  chunk('IDAT', deflateSync(new Uint8Array([0, 255, 0, 0, 255]))), chunk('IEND', new Uint8Array()),
]));
const serviceA = new BoardService(db, ownerA, r2), serviceB = new BoardService(db, ownerB, r2);
const taskA = await serviceA.mutate('create', { task: { title: 'Synthetic OAuth fixture A' }, requestKey: 'fixture-create-a' });
const taskB = await serviceB.mutate('create', { task: { title: 'Synthetic OAuth fixture B' }, requestKey: 'fixture-create-b' });
const attachmentA = await serviceA.activity.upload(taskA.id, 'fixture-upload-a', png, 'synthetic.png');
const commentA = await serviceA.activity.mutate('add', { taskId: taskA.id, body: 'Synthetic route comment', attachmentIds: [attachmentA.id], requestKey: 'fixture-comment-a' });

beforeEach(() => {
  globalThis.__authRouteEnv.TASK_BOARD_READ_ONLY = 'false';
  globalThis.__authRouteEnv.TASK_BOARD_AUTH_POLICY = JSON.stringify(policy);
  users = structuredClone(originalUsers); identities = structuredClone(originalIdentities);
  requests.length = 0;
  delete globalThis.__authRoutePageHeaders;
});
after(() => {
  globalThis.fetch = originalFetch;
  delete globalThis.__authRouteEnv; delete globalThis.__authRoutePageHeaders;
  sqlite.close();
  assert.deepEqual(unexpectedFetches, [], 'No route test attempted a live network call');
});

const bearer = value => ({ authorization: 'Bearer ' + value });
const request = (path, body, headers = {}, method = 'POST') => new Request(origin + path, {
  method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
  ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
});
const rpcRequest = (method, params, headers = {}) => request('/mcp', { jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }, headers);
const rpcCall = (name, args, headers) => mcp.POST(rpcRequest('tools/call', { name, arguments: args }, headers));
const apiCall = (name, args, headers = {}) => board.POST(request('/api/board', { name, args }, headers));
async function rpcValue(response) {
  assert.equal(response.status, 200);
  const message = await response.json();
  assert.equal(message.result.isError, false);
  return JSON.parse(message.result.content[0].text);
}
async function denied(response, status, code) {
  assert.equal(response.status, status);
  if (code) assert.equal((await response.json()).error, code);
  assert.match(response.headers.get('cache-control'), /no-store/);
  if (status === 401) {
    assert.equal(response.headers.get('www-authenticate'), `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="openid profile email"`);
  }
}
function cookieFrom(response, name) {
  const value = response.headers.getSetCookie().find(value => value.startsWith(name + '='));
  assert.ok(value, name + ' is issued');
  return value.split(';')[0];
}
async function beginBrowserAuthorization(subject = 'user_synthetic_a', idClaims = {}) {
  const started = await signin.GET(request('/auth/signin?return_to=%2F', undefined, {}, 'GET'));
  assert.equal(started.status, 302);
  const authorize = new URL(started.headers.get('location'));
  assert.equal(authorize.origin, issuer);
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorize.searchParams.get('resource'), audience);
  assert.equal(authorize.searchParams.get('redirect_uri'), origin + '/auth/callback');
  const code = 'synthetic-code-' + crypto.randomUUID();
  codes.set(code, { subject, nonce: authorize.searchParams.get('nonce'), challenge: authorize.searchParams.get('code_challenge'), idClaims });
  return { started, authorize, code, callbackPath: '/auth/callback?' + new URLSearchParams({ code, state: authorize.searchParams.get('state') }), transactionCookie: cookieFrom(started, TRANSACTION_COOKIE) };
}
async function browserSession(subject = 'user_synthetic_a', idClaims = {}) {
  const authorization = await beginBrowserAuthorization(subject, idClaims);
  const completed = await callback.GET(request(authorization.callbackPath, undefined, { cookie: authorization.transactionCookie }, 'GET'));
  return { ...authorization, completed, cookie: completed.status === 303 ? cookieFrom(completed, SESSION_COOKIE) : null };
}

test('every anonymous MCP transport and JSON-RPC method challenges before parsing or discovery', async () => {
  for (const method of ['initialize', 'tools/list', 'ping', 'notifications/initialized', 'tools/call']) {
    await denied(await mcp.POST(rpcRequest(method, { name: 'list_tasks', arguments: {} })), 401, 'sign_in_required');
  }
  await denied(await mcp.POST(request('/mcp', 'malformed-json')), 401);
  for (const method of ['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    await denied(await mcp[method](request('/mcp', undefined, {}, method)), 401);
  }
});

test('forged proxy and agent identity headers grant no route access', async () => {
  const forged = {
    'oai-authenticated-user-id': ownerA, 'oai-authenticated-user-email': 'owner-a@example.com',
    'cf-access-authenticated-user-email': 'owner-a@example.com', 'x-user-id': ownerA,
    'x-agent-name': 'owner', 'x-task-board-owner': ownerA,
  };
  await denied(await rpcCall('get_task', { id: taskA.id }, forged), 401);
  await denied(await apiCall('get_task', { id: taskA.id }, forged), 401);
  await denied(await images.GET(request('/api/images?id=' + attachmentA.id, undefined, forged, 'GET')), 401);
  assert.equal(requests.length, 0);
});

test('a signed unapproved identity fails even when token claims assert the allowlisted email and owner', async () => {
  const headers = bearer(await token({ sub: 'user_unapproved', email: 'owner-a@example.com', email_verified: true, owner: ownerA, role: 'owner' }));
  await denied(await mcp.POST(rpcRequest('initialize', null, headers)), 403, 'identity_not_allowed');
  await denied(await apiCall('get_task', { id: taskA.id }, headers), 403, 'identity_not_allowed');
  await denied(await images.GET(request('/api/images?id=' + attachmentA.id, undefined, headers, 'GET')), 403, 'identity_not_allowed');
  const session = await browserSession('user_unapproved');
  await denied(session.completed, 403, 'identity_not_allowed');
  assert.equal(session.cookie, null);
});

test('real browser PKCE/state/ID-token callback, browser API, and MCP expose the same owner-scoped record IDs', async () => {
  const session = await browserSession();
  assert.equal(session.completed.status, 303);
  assert.equal(session.completed.headers.get('location'), '/');
  assert.match(session.completed.headers.getSetCookie().join(';'), /Secure; HttpOnly; SameSite=Lax/);
  globalThis.__authRoutePageHeaders = new Headers({ cookie: session.cookie });
  const principal = await requireBoardPrincipal('/');
  assert.equal(principal.ownerId, ownerA);
  assert.equal(principal.canWrite, true);
  const browser = await apiCall('list_tasks', {}, { cookie: session.cookie });
  const api = await apiCall('list_tasks', {}, bearer(await token()));
  const agent = await rpcValue(await rpcCall('list_tasks', {}, bearer(await token())));
  const ids = data => data.tasks.map(task => task.id).sort();
  const expected = (await serviceA.list()).map(task => task.id).sort();
  assert.deepEqual(ids(await browser.json()), expected);
  assert.deepEqual(ids(await api.json()), expected);
  assert.deepEqual(ids(agent), expected);
  assert.ok(expected.includes(taskA.id));
  assert.ok(!expected.includes(taskB.id));
  const browserComments = await apiCall('list_comments', { taskId: taskA.id }, { cookie: session.cookie });
  assert.deepEqual((await browserComments.json()).comments.map(comment => comment.id), [commentA.id]);
  const agentComment = await rpcValue(await rpcCall('get_comment', { id: commentA.id }, bearer(await token())));
  assert.equal(agentComment.comment.id, commentA.id);
  assert.deepEqual(agentComment.attachments.map(attachment => attachment.id), [attachmentA.id]);
  const initialized = await mcp.POST(rpcRequest('initialize', null, bearer(await token())));
  assert.equal(initialized.status, 200);
  const authenticatedGet = await mcp.GET(request('/mcp', undefined, bearer(await token()), 'GET'));
  assert.equal(authenticatedGet.status, 405);
});

test('MCP resource discovery returns configured issuer and relays genuine authorization-server PKCE metadata', async () => {
  const metadata = await oauthDiscovery(request('/.well-known/oauth-protected-resource/mcp', undefined, {}, 'GET'), globalThis.__authRouteEnv);
  assert.equal(metadata.status, 200);
  assert.deepEqual(await metadata.json(), {
    resource: audience, authorization_servers: [issuer], bearer_methods_supported: ['header'], scopes_supported: ['openid', 'profile', 'email'],
  });
  const discovered = await oauthDiscovery(request('/.well-known/oauth-authorization-server/mcp', undefined, {}, 'GET'), globalThis.__authRouteEnv);
  assert.equal(discovered.status, 200);
  const actual = await discovered.json();
  assert.equal(actual.issuer, issuer);
  assert.deepEqual(actual.code_challenge_methods_supported, ['S256']);
  assert.equal(actual.registration_endpoint, undefined, 'The application does not invent an enabled registration endpoint');
  assert.ok(requests.some(request => request.url === issuer + '/.well-known/oauth-authorization-server'));
});

test('browser callback rejects mismatched/missing state before exchange and consumes a successful transaction exactly once', async () => {
  const authorization = await beginBrowserAuthorization();
  const tokenRequests = () => requests.filter(request => request.url === issuer + '/oauth2/token').length;
  const before = tokenRequests();
  for (const query of [
    new URLSearchParams({ code: authorization.code, state: 'another-state' }),
    new URLSearchParams({ code: authorization.code }),
    new URLSearchParams({ code: authorization.code, state: authorization.authorize.searchParams.get('state'), error: 'access_denied' }),
  ]) {
    const response = await callback.GET(request('/auth/callback?' + query, undefined, { cookie: authorization.transactionCookie }, 'GET'));
    await denied(response, 401, 'invalid_oauth_state');
    assert.ok(!response.headers.getSetCookie().some(value => value.startsWith(SESSION_COOKIE + '=')));
  }
  const noTransaction = await callback.GET(request(authorization.callbackPath, undefined, {}, 'GET'));
  await denied(noTransaction, 401, 'invalid_oauth_state');
  assert.equal(tokenRequests(), before);
  const valid = await callback.GET(request(authorization.callbackPath, undefined, { cookie: authorization.transactionCookie }, 'GET'));
  assert.equal(valid.status, 303);
  assert.ok(cookieFrom(valid, SESSION_COOKIE));
  assert.equal(tokenRequests(), before + 1);
  const replay = await callback.GET(request(authorization.callbackPath, undefined, { cookie: authorization.transactionCookie }, 'GET'));
  await denied(replay, 401, 'invalid_oauth_state');
  assert.equal(tokenRequests(), before + 1);
});

test('browser callback validates the signed nonce, OIDC audience, issuer and expiry before issuing a session', async () => {
  for (const idClaims of [
    { nonce: 'wrong-transaction-nonce' }, { nonce: undefined }, { aud: audience },
    { iss: 'https://other.example.authkit.app' }, { exp: Math.floor(Date.now() / 1000) - 1 },
  ]) {
    const session = await browserSession('user_synthetic_a', idClaims);
    await denied(session.completed, 401, 'invalid_token');
    assert.equal(session.cookie, null);
    assert.ok(!session.completed.headers.getSetCookie().some(value => value.startsWith(SESSION_COOKIE + '=')));
  }
});

test('browser token exchange uses Workers manual mode and rejects redirects or a changed response URL without a session', async () => {
  const valid = await beginBrowserAuthorization();
  codes.get(valid.code).tokenResponse = response => { Object.defineProperty(response, 'url', { value: issuer + '/oauth2/token' }); return response; };
  assert.equal((await callback.GET(request(valid.callbackPath, undefined, { cookie: valid.transactionCookie }, 'GET'))).status, 303);
  for (const response of [
    ...[301, 302, 303, 307, 308].map(status => () => new Response(null, { status, headers: { Location: 'https://foreign.example/token' } })),
    value => { Object.defineProperty(value, 'redirected', { value: true }); return value; },
    value => { Object.defineProperty(value, 'url', { value: 'https://foreign.example/token' }); return value; },
    value => { Object.defineProperty(value, 'url', { value: issuer + '/other-token' }); return value; },
  ]) {
    const authorization = await beginBrowserAuthorization();
    codes.get(authorization.code).tokenResponse = response;
    const completed = await callback.GET(request(authorization.callbackPath, undefined, { cookie: authorization.transactionCookie }, 'GET'));
    await denied(completed, 401, 'oauth_failed');
    assert.ok(!completed.headers.getSetCookie().some(value => value.startsWith(SESSION_COOKIE + '=')));
  }
});

test('tampered and duplicate browser cookies fail closed on browser, API, MCP and image access', async () => {
  const session = await browserSession();
  const value = session.cookie.slice(SESSION_COOKIE.length + 1);
  const tampered = SESSION_COOKIE + '=' + (value[0] === 'A' ? 'B' : 'A') + value.slice(1);
  for (const cookie of [tampered, session.cookie + '; ' + session.cookie]) {
    const headers = { cookie };
    await denied(await apiCall('list_tasks', {}, headers), 401, 'invalid_session');
    await denied(await mcp.POST(rpcRequest('initialize', null, headers)), 401, 'invalid_session');
    await denied(await images.GET(request('/api/images?id=' + attachmentA.id, undefined, headers, 'GET')), 401, 'invalid_session');
    globalThis.__authRoutePageHeaders = new Headers(headers);
    await assert.rejects(() => requireBoardPrincipal('/'), error => error.location === '/auth/signin?return_to=%2F');
  }
});

test('read-only MCP tools are filtered and OIDC or write-looking strings never grant mutations/import/uploads', async () => {
  const before = await serviceA.export();
  const mutationNames = [
    'create_task', 'update_task', 'complete_task', 'archive_task', 'restore_task',
    'add_comment', 'edit_comment', 'archive_comment', 'restore_comment', 'import_tasks',
  ];
  for (const client_id of ['synthetic-read-client', 'dynamic-unknown-client', 'https://client.example.com/client.json']) {
    const headers = bearer(await token({ client_id, scope: 'openid profile email offline_access tasks:write', permissions: ['write'], role: 'owner' }));
    const listed = await mcp.POST(rpcRequest('tools/list', null, headers));
    assert.equal(listed.status, 200);
    const names = (await listed.json()).result.tools.map(tool => tool.name);
    assert.ok(names.includes('list_tasks'));
    for (const name of mutationNames) {
      assert.ok(!names.includes(name), 'A read-only client must not discover ' + name);
      await denied(await rpcCall(name, {}, headers), 403, 'permission_denied');
      await denied(await apiCall(name, {}, headers), 403, 'permission_denied');
    }
    await denied(await apiCall('seed_samples', {}, headers), 403, 'permission_denied');
    await denied(await apiCall('add_comment', { taskId: taskA.id, body: 'Denied', requestKey: 'readonly-comment-attempt' }, headers), 403, 'permission_denied');
    const uploaded = await images.POST(new Request(origin + '/api/images', { method: 'POST', headers: { ...headers, 'content-type': 'image/png', 'x-task-id': taskA.id, 'x-upload-key': 'readonly-image-attempt' }, body: png }));
    await denied(uploaded, 403, 'permission_denied');
    assert.equal((await rpcValue(await rpcCall('get_task', { id: taskA.id }, headers))).task.id, taskA.id);
  }
  const afterExport = await serviceA.export();
  for (const key of ['tasks', 'history', 'comments', 'commentHistory', 'attachments']) assert.deepEqual(afterExport[key], before[key]);
});

test('owner-delegated DCR/CIMD agents discover writes and create/edit/archive tasks and comments through real routes', async () => {
  globalThis.__authRouteEnv.TASK_BOARD_AUTH_POLICY = JSON.stringify(delegatedPolicy());
  for (const [index, client_id] of ['dynamic-unknown-client', 'https://client.example.com/client.json'].entries()) {
    const headers = bearer(await token({ client_id, scope: 'openid profile email' }));
    const listed = await mcp.POST(rpcRequest('tools/list', null, headers));
    const names = (await listed.json()).result.tools.map(tool => tool.name);
    for (const name of ['create_task', 'update_task', 'complete_task', 'archive_task', 'restore_task', 'add_comment', 'edit_comment', 'archive_comment', 'restore_comment', 'import_tasks']) assert.ok(names.includes(name), name);
    const created = await rpcValue(await rpcCall('create_task', { task: { title: 'Synthetic delegated task ' + index }, requestKey: 'delegated-create-' + index }, headers));
    const task = created.task;
    const edit = { id: task.id, expectedRevision: task.revision, patch: { title: 'Synthetic delegated edit ' + index }, requestKey: 'delegated-edit-' + index };
    const editedResponse = await apiCall('update_task', edit, headers);
    assert.equal(editedResponse.status, 200);
    const edited = (await editedResponse.json()).task;
    assert.equal(edited.revision, 2);
    assert.deepEqual((await rpcValue(await rpcCall('update_task', edit, headers))).task, edited);
    assert.equal((await serviceA.history(task.id)).filter(event => event.action === 'update').length, 1);
    await denied(await apiCall('update_task', { ...edit, patch: { title: 'Different retry' } }, headers), 409, 'idempotency_conflict');
    let comment = (await rpcValue(await rpcCall('add_comment', { taskId: task.id, body: 'Synthetic delegated comment', requestKey: 'delegated-comment-' + index }, headers))).comment;
    const commentEdit = await apiCall('edit_comment', { id: comment.id, expectedRevision: comment.revision, body: 'Synthetic delegated comment edit', requestKey: 'delegated-comment-edit-' + index }, headers);
    assert.equal(commentEdit.status, 200);
    comment = (await commentEdit.json()).comment;
    comment = (await rpcValue(await rpcCall('archive_comment', { id: comment.id, expectedRevision: comment.revision, requestKey: 'delegated-comment-remove-' + index }, headers))).comment;
    assert.equal(comment.archived, true);
    const archived = (await rpcValue(await rpcCall('archive_task', { id: task.id, expectedRevision: edited.revision, requestKey: 'delegated-archive-' + index }, headers))).task;
    assert.equal(archived.archived, true);
    assert.equal(archived.revision, 3);
    await denied(await apiCall('update_task', { id: taskB.id, expectedRevision: taskB.revision, patch: { title: 'Cross-owner denied' }, requestKey: 'delegated-cross-owner-' + index }, headers), 404, 'not_found');
  }
});

test('owner delegation cannot bypass explicit client rules, owner isolation or the verified identity admission rule', async () => {
  globalThis.__authRouteEnv.TASK_BOARD_AUTH_POLICY = JSON.stringify(delegatedPolicy());
  for (const claims of [
    { client_id: 'synthetic-read-client', scope: 'openid tasks:write' },
    { client_id: 'synthetic-write-client', scope: 'openid profile email' },
    { client_id: 'synthetic-write-client', scope: 'tasks:write-extra' },
    { sub: 'user_synthetic_b', client_id: 'dynamic-unknown-client', owner: ownerA },
  ]) {
    const headers = bearer(await token(claims));
    await denied(await rpcCall('create_task', { task: { title: 'Denied delegate' }, requestKey: 'delegated-rule-denied' }, headers), 403, 'permission_denied');
    await denied(await apiCall('create_task', { task: { title: 'Denied delegate' }, requestKey: 'delegated-rule-denied' }, headers), 403, 'permission_denied');
  }
  const unapproved = bearer(await token({ sub: 'user_unapproved', client_id: 'dynamic-unknown-client', email: 'owner-a@example.com', owner: ownerA }));
  await denied(await rpcCall('create_task', {}, unapproved), 403, 'identity_not_allowed');
  users.user_synthetic_a.email_verified = false;
  await denied(await apiCall('create_task', {}, bearer(await token({ client_id: 'dynamic-unknown-client' }))), 403, 'identity_not_allowed');
});

test('the same delegated token loses mutations on owner revocation, client restriction or global freeze while reads remain available', async () => {
  const approved = delegatedPolicy();
  globalThis.__authRouteEnv.TASK_BOARD_AUTH_POLICY = JSON.stringify(approved);
  const headers = bearer(await token({ client_id: 'dynamic-unknown-client' }));
  assert.equal((await getBoardPrincipal(new Request(origin + '/api/board', { headers }))).canWrite, true);
  const restricted = structuredClone(approved); restricted.clients.push({ clientId: 'dynamic-unknown-client', access: 'read' });
  const revoked = structuredClone(approved); revoked.owners[0].agentAccess = 'read';
  for (const [activePolicy, flag] of [[restricted, 'false'], [revoked, 'false'], [approved, 'true'], [approved, undefined]]) {
    globalThis.__authRouteEnv.TASK_BOARD_AUTH_POLICY = JSON.stringify(activePolicy);
    if (flag === undefined) delete globalThis.__authRouteEnv.TASK_BOARD_READ_ONLY;
    else globalThis.__authRouteEnv.TASK_BOARD_READ_ONLY = flag;
    assert.equal((await getBoardPrincipal(new Request(origin + '/api/board', { headers }))).canWrite, false);
    const tools = await mcp.POST(rpcRequest('tools/list', null, headers));
    assert.ok(!(await tools.json()).result.tools.some(tool => tool.name === 'create_task'));
    await denied(await apiCall('create_task', { task: { title: 'Denied frozen delegate' }, requestKey: 'delegated-freeze-denied' }, headers), 403, 'permission_denied');
    await denied(await rpcCall('create_task', { task: { title: 'Denied frozen delegate' }, requestKey: 'delegated-freeze-denied' }, headers), 403, 'permission_denied');
    await denied(await images.POST(new Request(origin + '/api/images', { method: 'POST', headers: { ...headers, 'content-type': 'image/png', 'x-task-id': taskA.id, 'x-upload-key': 'delegated-image-denied' }, body: png })), 403, 'permission_denied');
    assert.equal((await apiCall('get_task', { id: taskA.id }, headers)).status, 200);
  }
});

test('cryptographic token negatives fail at every protected route before authoritative identity lookup', async () => {
  const now = Math.floor(Date.now() / 1000);
  const invalid = [
    await token({}, wrongKey),
    await token({}, new TextEncoder().encode('synthetic-hmac-key-at-least-32-bytes'), 'HS256'),
    await token({ iss: 'https://other.example.authkit.app' }),
    await token({ aud: 'https://other.example.com/mcp' }),
    await token({ exp: now - 1 }), await token({ exp: undefined }),
    await token({ iat: now + 60 }), await token({ nbf: now + 60 }),
    await token({ sub: 'client_synthetic_machine' }), await token({ sid: undefined }),
    await token({ sid: '' }), await token({ client_id: undefined }),
    await token({ act: { sub: 'user_synthetic_b' } }),
    await token({ aud: browserClient, nonce: 'synthetic-nonce', client_id: undefined, sid: undefined }),
    'not-a-jwt',
  ];
  for (const jwt of invalid) {
    const headers = bearer(jwt);
    await denied(await mcp.POST(rpcRequest('initialize', null, headers)), 401, 'invalid_token');
    await denied(await apiCall('get_task', { id: taskA.id }, headers), 401, 'invalid_token');
    await denied(await images.GET(request('/api/images?id=' + attachmentA.id, undefined, headers, 'GET')), 401, 'invalid_token');
  }
  assert.ok(!requests.some(request => request.url.startsWith('https://api.workos.com/')));
});

test('approved identities cannot read another owner task/comment/image or choose ownership in arguments', async () => {
  const headers = bearer(await token({ sub: 'user_synthetic_b', email: 'owner-a@example.com', owner: ownerA }));
  await denied(await apiCall('get_task', { id: taskA.id }, headers), 404, 'not_found');
  await denied(await apiCall('get_comment', { id: commentA.id }, headers), 404, 'not_found');
  const crossed = await rpcCall('get_task', { id: taskA.id }, headers);
  const message = await crossed.json();
  assert.equal(message.result.isError, true);
  assert.equal(JSON.parse(message.result.content[0].text).error, 'not_found');
  await denied(await images.GET(request('/api/images?id=' + attachmentA.id, undefined, headers, 'GET')), 404, 'not_found');
  const own = await rpcValue(await rpcCall('get_task', { id: taskB.id }, headers));
  assert.equal(own.task.id, taskB.id);
  await denied(await apiCall('list_tasks', { owner: ownerA }, headers), 400, 'invalid_input');
});

test('anonymous, forged, and cross-site image requests cannot bypass authorization; approved owner receives exact PNG bytes', async () => {
  for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    await denied(await images[method](request('/api/images?id=' + attachmentA.id, undefined, {}, method)), 401);
  }
  const headers = bearer(await token());
  const response = await images.GET(request('/api/images?id=' + attachmentA.id, undefined, headers, 'GET'));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.match(response.headers.get('cache-control'), /private, no-store/);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), (await normalizePng(png)).bytes);
  await denied(await images.GET(request('/api/images?id=' + attachmentA.id, undefined, { ...headers, origin: 'https://evil.example' }, 'GET')), 403, 'origin_mismatch');
});

test('a malformed or expired bearer never falls back to the privileged browser cookie', async () => {
  const session = await browserSession();
  for (const authorization of ['Bearer not-a-jwt', 'Basic forged', 'Bearer ' + await token({ exp: Math.floor(Date.now() / 1000) - 1 })]) {
    const headers = { cookie: session.cookie, authorization, origin };
    await denied(await apiCall('create_task', { task: { title: 'Denied fallback' }, requestKey: 'denied-cookie-fallback' }, headers), 401, 'invalid_token');
    await denied(await mcp.POST(rpcRequest('initialize', null, headers)), 401, 'invalid_token');
    await denied(await images.GET(request('/api/images?id=' + attachmentA.id, undefined, headers, 'GET')), 401, 'invalid_token');
  }
});

test('browser cookie writes require exact Origin and reject cross-site/API anonymous bypasses', async () => {
  const session = await browserSession();
  const args = { task: { title: 'Synthetic same-origin write' }, requestKey: 'same-origin-browser-write' };
  for (const headers of [
    { cookie: session.cookie }, { cookie: session.cookie, origin: 'https://evil.example' },
    { cookie: session.cookie, origin: 'null' }, { cookie: session.cookie, origin: origin + ':443' },
    { cookie: session.cookie, origin, 'sec-fetch-site': 'cross-site' },
  ]) {
    await denied(await apiCall('create_task', args, headers), 403, 'origin_mismatch');
    await denied(await rpcCall('create_task', args, headers), 403, 'origin_mismatch');
    const image = await images.POST(new Request(origin + '/api/images', { method: 'POST', headers: { ...headers, 'content-type': 'image/png', 'x-task-id': taskA.id, 'x-upload-key': 'denied-origin-image' }, body: png }));
    await denied(image, 403, 'origin_mismatch');
  }
  await denied(await apiCall('list_tasks', {}), 401, 'sign_in_required');
  for (const method of ['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    await denied(await board[method](request('/api/board', undefined, {}, method)), 401);
  }
  const created = await apiCall('create_task', args, { cookie: session.cookie, origin });
  assert.equal(created.status, 200);
  assert.equal((await created.json()).task.title, args.task.title);
});

test('the same bearer and browser cookie lose access immediately after allowlist or authoritative identity removal', async () => {
  const jwt = await token(), session = await browserSession();
  const bearerHeaders = bearer(jwt), browserHeaders = { cookie: session.cookie };
  assert.equal((await apiCall('get_task', { id: taskA.id }, bearerHeaders)).status, 200);
  assert.equal((await apiCall('get_task', { id: taskA.id }, browserHeaders)).status, 200);
  const before = requests.filter(request => request.url.startsWith('https://api.workos.com/')).length;
  await rpcCall('list_tasks', {}, bearerHeaders); await apiCall('list_tasks', {}, browserHeaders);
  assert.equal(requests.filter(request => request.url.startsWith('https://api.workos.com/')).length - before, 4);
  globalThis.__authRouteEnv.TASK_BOARD_AUTH_POLICY = JSON.stringify({ ...policy, owners: policy.owners.filter(owner => owner.ownerId !== ownerA) });
  for (const headers of [bearerHeaders, browserHeaders]) {
    await denied(await apiCall('get_task', { id: taskA.id }, headers), 403, 'identity_not_allowed');
    await denied(await rpcCall('list_tasks', {}, headers), 403, 'identity_not_allowed');
    await denied(await images.GET(request('/api/images?id=' + attachmentA.id, undefined, headers, 'GET')), 403, 'identity_not_allowed');
  }
  globalThis.__authRouteEnv.TASK_BOARD_AUTH_POLICY = JSON.stringify(policy);
  identities.user_synthetic_a = [];
  for (const headers of [bearerHeaders, browserHeaders]) await denied(await apiCall('list_tasks', {}, headers), 403, 'identity_not_allowed');
  identities.user_synthetic_a = structuredClone(originalIdentities.user_synthetic_a);
  users.user_synthetic_a.email_verified = false;
  for (const headers of [bearerHeaders, browserHeaders]) await denied(await apiCall('list_tasks', {}, headers), 403, 'identity_not_allowed');
});

test('browser page guard redirects anonymous sessions and reevaluates the allowlist for existing cookies', async () => {
  globalThis.__authRoutePageHeaders = new Headers();
  assert.equal(await getBoardPrincipal(), null);
  await assert.rejects(() => requireBoardPrincipal('/'), error => error.location === '/auth/signin?return_to=%2F');
  const session = await browserSession();
  globalThis.__authRoutePageHeaders = new Headers({ cookie: session.cookie });
  assert.equal((await requireBoardPrincipal('/')).ownerId, ownerA);
  globalThis.__authRouteEnv.TASK_BOARD_AUTH_POLICY = JSON.stringify({ ...policy, owners: [] });
  await assert.rejects(() => requireBoardPrincipal('/'), error => error.status === 403 && error.code === 'identity_not_allowed');
});

test('registered-client custom scopes are exact and concurrent route edits retain one revision and one idempotent event', async () => {
  const registered = { client_id: 'synthetic-write-client' };
  for (const scope of ['openid profile email', 'tasks:write-extra']) {
    await denied(await apiCall('create_task', { task: { title: 'Denied scope' }, requestKey: 'denied-custom-scope' }, bearer(await token({ ...registered, scope }))), 403, 'permission_denied');
  }
  const headers = bearer(await token({ ...registered, scope: 'openid tasks:write' }));
  const created = await apiCall('create_task', { task: { title: 'Synthetic concurrent route edits' }, requestKey: 'concurrent-fixture-create' }, headers);
  assert.equal(created.status, 200);
  const task = (await created.json()).task;
  const edits = ['a', 'b'].map(label => ({ id: task.id, expectedRevision: task.revision, requestKey: 'concurrent-update-' + label, patch: { title: 'Synthetic winner ' + label } }));
  const [api, rpc] = await Promise.all([apiCall('update_task', edits[0], headers), rpcCall('update_task', edits[1], headers)]);
  const apiResult = await api.json(), rpcResult = await rpc.json();
  const rpcData = JSON.parse(rpcResult.result.content[0].text);
  const apiWon = api.status === 200;
  assert.equal(Number(apiWon) + Number(rpcResult.result.isError === false), 1);
  if (apiWon) assert.equal(rpcData.error, 'revision_conflict');
  else { assert.equal(api.status, 409); assert.equal(apiResult.error, 'revision_conflict'); }
  const final = await serviceA.get(task.id);
  assert.equal(final.revision, task.revision + 1);
  assert.equal((await serviceA.history(task.id)).filter(event => event.action === 'update').length, 1);
  const winner = edits[apiWon ? 0 : 1];
  const retry = await apiCall('update_task', winner, headers);
  assert.equal(retry.status, 200);
  assert.deepEqual((await retry.json()).task, final);
  assert.equal((await serviceA.history(task.id)).filter(event => event.action === 'update').length, 1);
  await denied(await apiCall('update_task', { ...winner, patch: { title: 'Different retry input' } }, headers), 409, 'idempotency_conflict');
});


test('cutover freeze is read-only by default, rejects typos, and still permits owner reads', async () => {
  const session = await browserSession();
  const browserHeaders = {cookie: session.cookie, origin};
  const writeHeaders = {authorization: 'Bearer ' + await token({client_id:'synthetic-write-client',scope:'openid profile email tasks:write'})};
  for (const flag of [undefined, 'true']) {
    if (flag === undefined) delete globalThis.__authRouteEnv.TASK_BOARD_READ_ONLY;
    else globalThis.__authRouteEnv.TASK_BOARD_READ_ONLY = flag;
    for (const headers of [browserHeaders,writeHeaders]) {
      await denied(await apiCall('create_task',{task:{title:'Denied freeze write'},requestKey:'denied-freeze-write'},headers),403,'permission_denied');
      await denied(await rpcCall('create_task',{task:{title:'Denied freeze write'},requestKey:'denied-freeze-write'},headers),403,'permission_denied');
      assert.equal((await apiCall('list_tasks',{},headers)).status,200);
    }
  }
  globalThis.__authRouteEnv.TASK_BOARD_READ_ONLY = 'TRUE';
  await denied(await apiCall('list_tasks',{},browserHeaders),503,'auth_configuration');
});

test('migration capture requires an explicit source freeze even for an approved read-only owner or prior cursor', async () => {
  const session = await browserSession();
  const readHeaders = bearer(await token());
  const credentials = [readHeaders, { cookie: session.cookie }, bearer(await token({ client_id: 'synthetic-write-client', scope: 'openid tasks:write' }))];
  globalThis.__authRouteEnv.TASK_BOARD_READ_ONLY = 'true';
  const started = await apiCall('export_migration_page', { pageSize: 1 }, readHeaders);
  assert.equal(started.status, 200);
  const first = await started.json();
  assert.equal(first.version, 3);
  assert.ok(first.nextCursor);
  const keyCount = sqlite.prepare('SELECT COUNT(*) AS n FROM backup_keys').get().n;
  for (const flag of ['false', undefined]) {
    if (flag === undefined) delete globalThis.__authRouteEnv.TASK_BOARD_READ_ONLY;
    else globalThis.__authRouteEnv.TASK_BOARD_READ_ONLY = flag;
    for (const headers of credentials) {
      // A missing flag freezes ordinary writes by default, but is not the
      // explicit migration boundary required for a full-state source capture.
      assert.equal((await apiCall('list_tasks', {}, headers)).status, 200);
      for (const args of [{}, { cursor: first.nextCursor }]) {
        await denied(await apiCall('export_migration_page', args, headers), 409, 'migration_requires_freeze');
        await denied(await rpcCall('export_migration_page', args, headers), 409, 'migration_requires_freeze');
      }
    }
  }
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM backup_keys').get().n, keyCount);
});

test('explicitly frozen migration captures remain read-scope operations with browser/API/MCP owner and retry fidelity', async () => {
  const session = await browserSession();
  globalThis.__authRouteEnv.TASK_BOARD_READ_ONLY = 'true';
  const expectedTasks = [...await serviceA.list(), ...await serviceA.list(true)].map(task => task.id).sort();
  for (const headers of [
    bearer(await token()),
    bearer(await token({ client_id: 'dynamic-unknown-client', scope: 'openid profile email' })),
    { cookie: session.cookie },
  ]) {
    const principal = await getBoardPrincipal(new Request(origin + '/api/board', { headers }));
    assert.equal(principal.ownerId, ownerA);
    assert.equal(principal.canWrite, false);
    const listed = await mcp.POST(rpcRequest('tools/list', null, headers));
    assert.equal(listed.status, 200);
    assert.ok((await listed.json()).result.tools.some(tool => tool.name === 'export_migration_page'));
    const api = await apiCall('export_migration_page', {}, headers);
    assert.equal(api.status, 200);
    assert.match(api.headers.get('cache-control'), /no-store/);
    const pages = [await api.json(), await rpcValue(await rpcCall('export_migration_page', {}, headers))];
    for (const page of pages) {
      assert.equal(page.version, 3);
      assert.equal(page.storageOwner, ownerA);
      assert.deepEqual(page.tasks.map(task => task.id).sort(), expectedTasks);
      assert.ok(!page.tasks.some(task => task.id === taskB.id));
      const original = sqlite.prepare('SELECT request_key,fingerprint FROM attachments WHERE owner=? AND id=?').get(ownerA, attachmentA.id);
      assert.deepEqual(page.uploadRetries.find(retry => retry.attachmentId === attachmentA.id), { attachmentId: attachmentA.id, requestKey: original.request_key, fingerprint: original.fingerprint });
    }
    // A continuation retains the route's freshly authenticated owner rather
    // than treating the opaque cursor as independent authorization.
    const continued = await rpcValue(await rpcCall('export_migration_page', { cursor: pages[0].nextCursor }, headers));
    assert.equal(continued.backupId, pages[0].backupId);
    assert.equal(continued.ownerTag, pages[0].ownerTag);
  }
});

test('migration capture rejects cross-owner cursors, caller-selected owners, forged identities, and revoked grants', async () => {
  globalThis.__authRouteEnv.TASK_BOARD_READ_ONLY = 'true';
  const ownerHeaders = bearer(await token());
  const ownerPage = await apiCall('export_migration_page', { pageSize: 1 }, ownerHeaders);
  assert.equal(ownerPage.status, 200);
  const capture = await ownerPage.json();
  const otherHeaders = {
    ...bearer(await token({ sub: 'user_synthetic_b', email: 'owner-a@example.com', owner: ownerA })),
    'x-task-board-owner': ownerA, 'oai-authenticated-user-id': ownerA,
  };
  const otherPage = await rpcValue(await rpcCall('export_migration_page', {}, otherHeaders));
  assert.equal(otherPage.storageOwner, ownerB);
  assert.deepEqual(otherPage.tasks.map(task => task.id).sort(), (await serviceB.list()).map(task => task.id).sort());
  assert.equal(otherPage.uploadRetries.length, 0);
  await denied(await apiCall('export_migration_page', { cursor: capture.nextCursor }, otherHeaders), 400, 'invalid_cursor');
  const crossed = await rpcCall('export_migration_page', { cursor: capture.nextCursor }, otherHeaders);
  assert.equal(crossed.status, 200);
  const crossedMessage = await crossed.json();
  assert.equal(crossedMessage.result.isError, true);
  assert.equal(JSON.parse(crossedMessage.result.content[0].text).error, 'invalid_cursor');
  await denied(await apiCall('export_migration_page', { owner: ownerA }, otherHeaders), 400, 'invalid_input');
  const selected = await rpcCall('export_migration_page', { owner: ownerA }, otherHeaders);
  const selectedMessage = await selected.json();
  assert.equal(selectedMessage.result.isError, true);
  assert.equal(JSON.parse(selectedMessage.result.content[0].text).error, 'invalid_input');
  await denied(await apiCall('export_migration_page', {}, { 'oai-authenticated-user-id': ownerA }), 401, 'sign_in_required');
  await denied(await rpcCall('export_migration_page', {}, bearer(await token({ sub: 'user_unapproved', email: 'owner-a@example.com', owner: ownerA }))), 403, 'identity_not_allowed');
  globalThis.__authRouteEnv.TASK_BOARD_AUTH_POLICY = JSON.stringify({ ...policy, owners: policy.owners.filter(owner => owner.ownerId !== ownerA) });
  await denied(await apiCall('export_migration_page', { cursor: capture.nextCursor }, ownerHeaders), 403, 'identity_not_allowed');
  await denied(await rpcCall('export_migration_page', { cursor: capture.nextCursor }, ownerHeaders), 403, 'identity_not_allowed');
});

test('browser cookies are bound to the configured origin even on alternate Worker hostnames', async () => {
  const session = await browserSession();
  const alternate = new Request('https://alternate.example/api/board',{method:'POST',headers:{cookie:session.cookie,origin:'https://alternate.example','content-type':'application/json'},body:JSON.stringify({name:'list_tasks',args:{}})});
  await denied(await board.POST(alternate),403,'origin_mismatch');
});
