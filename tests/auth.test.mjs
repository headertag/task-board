import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { authenticateBearer, authorizeWorkosUser, readAuthConfig, requirePermission, verifyBrowserIdToken } from '../lib/auth.ts';

const currentDate = new Date('2026-10-01T12:00:00Z');
const now = Math.floor(currentDate.getTime() / 1000);
const { publicKey, privateKey } = await generateKeyPair('RS256');
const jwk = { ...await exportJWK(publicKey), kid: 'synthetic-trusted-key', alg: 'RS256' };
const key = createLocalJWKSet({ keys: [jwk] });
const issuer = 'https://auth.example.authkit.app';
const audience = 'https://board.example.com/mcp';
const policy = {
  version: 1,
  owners: [
    { ownerId: 'legacy-owner-synthetic-a', identities: [{ provider: 'google', email: 'allowed@example.com', providerId: 'google-stable-101' }] },
    { ownerId: 'synthetic-owner-b', identities: [{ provider: 'github', providerId: 'github-stable-202' }] },
  ],
  clients: [
    { clientId: 'synthetic-read-client', access: 'read' },
    { clientId: 'synthetic-write-client', access: 'write', writeScope: 'tasks:write' },
  ],
};
const configFor = (value = policy, values = {}) => readAuthConfig({
  WORKOS_AUTHKIT_ISSUER: issuer,
  WORKOS_MCP_AUDIENCE: audience,
  WORKOS_API_KEY: 'synthetic-api-key',
  TASK_BOARD_AUTH_POLICY: JSON.stringify(value),
  ...values,
});
const config = configFor();
const profiles = {
  user_synthetic_a: { id: 'user_synthetic_a', email: 'Allowed@Example.com', email_verified: true, name: 'Synthetic Owner A' },
  user_synthetic_b: { id: 'user_synthetic_b', email: 'unverified@example.com', email_verified: false },
  user_unapproved: { id: 'user_unapproved', email: 'unapproved@example.com', email_verified: true },
};
const identities = {
  user_synthetic_a: [{ type: 'OAuth', provider: 'GoogleOAuth', idp_id: 'google-stable-101' }],
  user_synthetic_b: [{ type: 'OAuth', provider: 'GithubOAuth', idp_id: 'github-stable-202' }],
  user_unapproved: [{ type: 'OAuth', provider: 'GoogleOAuth', idp_id: 'google-stable-303' }],
};
function workosMock(users = profiles, social = identities) {
  const requests = [];
  const fetch = async (url, options) => {
    requests.push({ url, options });
    assert.equal(options.headers.Authorization, 'Bearer synthetic-api-key');
    assert.equal(options.redirect, 'manual');
    const match = /^https:\/\/api\.workos\.com\/user_management\/users\/([^/]+)(\/identities)?$/.exec(url);
    assert.ok(match, 'API key is sent only to the pinned WorkOS API');
    const subject = decodeURIComponent(match[1]);
    return Response.json((match[2] ? social : users)[subject] ?? {}, { status: users[subject] ? 200 : 404 });
  };
  return { requests, dependencies: { fetch, key, currentDate } };
}
const defaultClaims = {
  iss: issuer, aud: audience, sub: 'user_synthetic_a',
  client_id: 'synthetic-read-client', sid: 'app_consent_synthetic-101',
  scope: 'openid profile email offline_access', iat: now - 60, exp: now + 600,
};
async function token(patch = {}, signingKey = privateKey, header = {}) {
  const claims = { ...defaultClaims, ...patch };
  for (const name of Object.keys(claims)) if (claims[name] === undefined) delete claims[name];
  return new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: jwk.kid, ...header }).sign(signingKey);
}
const headersFor = value => new Headers({ authorization: `Bearer ${value}` });
const statusIs = (status, code) => error => error.status === status && (!code || error.code === code);

test('signed Connect user maps to the explicit existing owner and defaults to read-only', async () => {
  const mock = workosMock();
  const principal = await authenticateBearer(headersFor(await token()), config, mock.dependencies);
  assert.equal(principal.ownerId, 'legacy-owner-synthetic-a');
  assert.equal(principal.userId, principal.ownerId);
  assert.equal(principal.workosUserId, 'user_synthetic_a');
  assert.equal(principal.email, 'allowed@example.com');
  assert.equal(principal.displayName, 'Synthetic Owner A');
  assert.equal(principal.kind, 'connect');
  assert.equal(principal.canWrite, false);
  assert.equal(principal.consentId, 'app_consent_synthetic-101');
  assert.equal(mock.requests.length, 2);
  requirePermission(principal, 'read');
  assert.throws(() => requirePermission(principal, 'write'), statusIs(403, 'permission_denied'));
});

test('DCR/CIMD clients and supplied permission labels cannot elevate task rights', async () => {
  for (const client_id of ['https://client.example.com/client.json', 'dynamic-unknown-client', 'synthetic-read-client']) {
    const principal = await authenticateBearer(headersFor(await token({ client_id, scope: 'openid profile email tasks:write', permissions: ['write'], role: 'owner' })), config, workosMock().dependencies);
    assert.equal(principal.canWrite, false);
    assert.throws(() => requirePermission(principal, 'write'), statusIs(403));
  }
});

test('write requires an explicitly configured client and a granted custom consent scope', async () => {
  for (const [scope, expected] of [['openid profile email', false], ['openid tasks:write', true], ['tasks:write-extra', false]]) {
    const principal = await authenticateBearer(headersFor(await token({ client_id: 'synthetic-write-client', scope })), config, workosMock().dependencies);
    assert.equal(principal.canWrite, expected);
  }
});

test('GitHub stable provider ID remains authoritative with renamed or unverified email', async () => {
  const principal = await authenticateBearer(headersFor(await token({ sub: 'user_synthetic_b', email: 'allowed@example.com', email_verified: true })), config, workosMock().dependencies);
  assert.equal(principal.ownerId, 'synthetic-owner-b');
  assert.notEqual(principal.ownerId, 'legacy-owner-synthetic-a');
  const changed = { ...profiles, user_synthetic_b: { ...profiles.user_synthetic_b, email: 'renamed@example.com' } };
  assert.equal((await authenticateBearer(headersFor(await token({ sub: 'user_synthetic_b' })), config, workosMock(changed).dependencies)).ownerId, 'synthetic-owner-b');
});

test('caller-forged identity headers and signed-but-unapproved email claims do not authorize', async () => {
  const headers = new Headers({
    'oai-authenticated-user-id': 'legacy-owner-synthetic-a',
    'oai-authenticated-user-email': 'allowed@example.com',
    'cf-access-authenticated-user-email': 'allowed@example.com',
  });
  await assert.rejects(() => authenticateBearer(headers, config, workosMock().dependencies), statusIs(401));
  headers.set('authorization', `Bearer ${await token({ sub: 'user_unapproved', email: 'allowed@example.com', email_verified: true })}`);
  await assert.rejects(() => authenticateBearer(headers, config, workosMock().dependencies), statusIs(403, 'identity_not_allowed'));
});

test('verified email matching also requires the expected authoritative provider identity', async () => {
  const emailPolicy = { ...policy, owners: [{ ownerId: 'explicit-owner', identities: [{ provider: 'google', email: 'allowed@example.com' }] }] };
  const unverified = { ...profiles, user_synthetic_a: { ...profiles.user_synthetic_a, email_verified: false } };
  const jwtHeaders = headersFor(await token());
  await assert.rejects(() => authenticateBearer(jwtHeaders, configFor(emailPolicy), workosMock(unverified).dependencies), statusIs(403));
  for (const profile of [[], [{ type: 'OAuth', provider: 'GithubOAuth', idp_id: 'google-stable-101' }], [{ type: 'Password', provider: 'GoogleOAuth', idp_id: 'google-stable-101' }]]) {
    await assert.rejects(() => authenticateBearer(jwtHeaders, configFor(emailPolicy), workosMock(profiles, { ...identities, user_synthetic_a: profile }).dependencies), statusIs(403));
  }
});

test('JWT signature, algorithm, issuer, audience, expiry, issuance, and required claims fail closed before identity lookup', async () => {
  const wrongKey = (await generateKeyPair('RS256')).privateKey;
  const invalid = [
    await token({}, wrongKey),
    await token({}, new TextEncoder().encode('synthetic-hmac-key-with-at-least-32-bytes'), { alg: 'HS256' }),
    await token({ iss: 'https://other.example.authkit.app' }),
    await token({ iss: 'http://auth.example.authkit.app' }),
    await token({ aud: 'https://other.example.com/mcp' }),
    await token({ exp: now }),
    await token({ nbf: now + 60 }),
    await token({ iat: now + 60 }),
    await token({ exp: undefined }),
    await token({ iat: undefined }),
    await token({ aud: undefined }),
    await token({ sub: undefined }),
    await token({ sub: 'client_machine' }),
    await token({ sid: undefined }),
    await token({ sid: '' }),
    await token({ client_id: undefined }),
    await token({ client_id: 42 }),
    await token({ scope: ['tasks:write'] }),
    await token({ act: { sub: 'impersonator@example.com' } }),
    await token({}, privateKey, { kid: 'unknown-key' }),
    'not-a-jwt',
  ];
  for (const jwt of invalid) {
    const mock = workosMock();
    await assert.rejects(() => authenticateBearer(headersFor(jwt), config, mock.dependencies), statusIs(401, 'invalid_token'));
    assert.equal(mock.requests.length, 0);
  }
  for (const authorization of ['Basic abc', `Bearer ${await token()}, ${await token()}`, 'Bearer ', 'Bearer aaa.bbb.']) {
    await assert.rejects(() => authenticateBearer(new Headers({ authorization }), config, workosMock().dependencies), statusIs(401));
  }
});

test('authoritative API mismatch, failure, redirect, and missing records cannot grant access', async () => {
  const jwtHeaders = headersFor(await token());
  const mismatched = { ...profiles, user_synthetic_a: { ...profiles.user_synthetic_a, id: 'user_other' } };
  await assert.rejects(() => authenticateBearer(jwtHeaders, config, workosMock(mismatched).dependencies), statusIs(503, 'auth_unavailable'));
  await assert.rejects(() => authenticateBearer(jwtHeaders, config, workosMock({}).dependencies), statusIs(503, 'auth_unavailable'));
  for (const fetch of [async () => { throw new Error('upstream unavailable'); }, async () => new Response('', { status: 302 }), async () => Response.json({})]) {
    await assert.rejects(() => authenticateBearer(jwtHeaders, config, { key, currentDate, fetch }), statusIs(503, 'auth_unavailable'));
  }
  const redirected = async () => {
    const response = Response.json(profiles.user_synthetic_a);
    Object.defineProperty(response, 'redirected', { value: true });
    return response;
  };
  const oversized = async () => new Response(' '.repeat(65_537));
  const oversizedLength = async () => Response.json(profiles.user_synthetic_a, { headers: { 'content-length': '1000000' } });
  for (const fetch of [redirected, oversized, oversizedLength]) {
    await assert.rejects(() => authenticateBearer(jwtHeaders, config, { key, currentDate, fetch }), statusIs(503, 'auth_unavailable'));
  }
});

test('identity lookup uses Workers-compatible manual redirects and accepts the exact native response URL', async () => {
  const mock = workosMock();
  const fetch = async (url, options) => {
    const response = await mock.dependencies.fetch(url, options);
    Object.defineProperty(response, 'url', { value: url });
    return response;
  };
  const principal = await authenticateBearer(headersFor(await token()), config, { ...mock.dependencies, fetch });
  assert.equal(principal.ownerId, 'legacy-owner-synthetic-a');
  assert.equal(mock.requests.length, 2);
  assert.deepEqual(mock.requests.map(request => request.options.redirect), ['manual', 'manual']);
});

test('both authoritative identity endpoints reject redirects and changed final response URLs', async () => {
  const jwtHeaders = headersFor(await token());
  for (const identitiesEndpoint of [false, true]) {
    for (const status of [301, 302, 303, 307, 308, 400, 401, 500]) {
      const mock = workosMock();
      const fetch = async (url, options) => {
        if (url.endsWith('/identities') === identitiesEndpoint) {
          assert.equal(options.redirect, 'manual');
          return new Response(null, { status, headers: { Location: 'https://other.example.com/identity' } });
        }
        return mock.dependencies.fetch(url, options);
      };
      await assert.rejects(() => authenticateBearer(jwtHeaders, config, { ...mock.dependencies, fetch }), statusIs(503, 'auth_unavailable'));
    }
    for (const properties of [{ redirected: true }, { url: 'https://other.example.com/identity' }, { url: 'https://api.workos.com/user_management/users/user_other' }]) {
      const mock = workosMock();
      const fetch = async (url, options) => {
        const response = await mock.dependencies.fetch(url, options);
        if (url.endsWith('/identities') === identitiesEndpoint) {
          for (const [name, value] of Object.entries(properties)) Object.defineProperty(response, name, { value });
        }
        return response;
      };
      await assert.rejects(() => authenticateBearer(jwtHeaders, config, { ...mock.dependencies, fetch }), statusIs(503, 'auth_unavailable'));
    }
  }
});

test('consent IDs are opaque: a verified user token needs sid, without assuming an undocumented prefix', async () => {
  const principal = await authenticateBearer(headersFor(await token({ sid: 'opaque-synthetic-consent' })), config, workosMock().dependencies);
  assert.equal(principal.consentId, 'opaque-synthetic-consent');
});

test('allowlist and authoritative identities are checked on every request, without a privilege cache', async () => {
  const jwtHeaders = headersFor(await token());
  const mock = workosMock();
  await authenticateBearer(jwtHeaders, config, mock.dependencies);
  await authenticateBearer(jwtHeaders, config, mock.dependencies);
  assert.equal(mock.requests.length, 4);
  await assert.rejects(() => authenticateBearer(jwtHeaders, configFor({ ...policy, owners: [] }), mock.dependencies), statusIs(403));
  await assert.rejects(() => authenticateBearer(jwtHeaders, config, workosMock(profiles, { ...identities, user_synthetic_a: [] }).dependencies), statusIs(403));
});

test('mapping requires exact configured owner and fails closed on overlapping rules', async () => {
  const pinned = { ...policy, owners: [{ ownerId: 'legacy-owner', identities: [{ provider: 'google', email: 'allowed@example.com', workosUserId: 'user_other' }] }] };
  await assert.rejects(async () => authenticateBearer(headersFor(await token()), configFor(pinned), workosMock().dependencies), statusIs(403));
  const overlapping = { ...policy, owners: [
    { ownerId: 'owner-a', identities: [{ provider: 'google', email: 'allowed@example.com' }] },
    { ownerId: 'owner-b', identities: [{ provider: 'google', providerId: 'google-stable-101' }] },
  ] };
  await assert.rejects(async () => authenticateBearer(headersFor(await token()), configFor(overlapping), workosMock().dependencies), statusIs(403));
});

test('browser ID token pins OIDC client, nonce, issuer, expiry and authorized party', async () => {
  const expected = { clientId: 'synthetic-browser-client', nonce: 'synthetic-transaction-nonce' };
  const idClaims = { aud: expected.clientId, nonce: expected.nonce, client_id: undefined, sid: undefined, scope: undefined };
  const verified = await verifyBrowserIdToken(await token(idClaims), config, expected, { key, currentDate });
  assert.deepEqual(verified, { sub: 'user_synthetic_a', issuer, audience: expected.clientId, expiresAt: now + 600 });
  for (const patch of [{ nonce: undefined }, { nonce: 'another-nonce' }, { aud: audience }, { azp: 'other-client' }, { aud: [expected.clientId, 'another-client'] }, { exp: now }]) {
    await assert.rejects(async () => verifyBrowserIdToken(await token({ ...idClaims, ...patch }), config, expected, { key, currentDate }), statusIs(401));
  }
  const multi = await verifyBrowserIdToken(await token({ ...idClaims, aud: [expected.clientId, 'other-audience'], azp: expected.clientId }), config, expected, { key, currentDate });
  assert.equal(multi.sub, verified.sub);
  const principal = await authorizeWorkosUser(verified.sub, config, { kind: 'browser' }, workosMock().dependencies);
  assert.equal(principal.kind, 'browser');
  assert.equal(principal.canWrite, true);
  assert.equal(principal.ownerId, 'legacy-owner-synthetic-a');
  await assert.rejects(async () => authenticateBearer(headersFor(await token(idClaims)), config, workosMock().dependencies), statusIs(401));
});

test('private config validation rejects unsafe issuers, mutable GitHub selectors and OIDC write grants', () => {
  for (const issuerValue of ['http://auth.example.com', 'https://auth.example.com/path', 'https://user:pass@auth.example.com', 'https://auth.example.com?x=1']) {
    assert.throws(() => configFor(policy, { WORKOS_AUTHKIT_ISSUER: issuerValue }), statusIs(503, 'auth_not_configured'));
  }
  for (const value of [
    { ...policy, version: 2 },
    { ...policy, owners: [{ ownerId: 'owner', identities: [{ provider: 'github', email: 'mutable@example.com' }] }] },
    { ...policy, owners: [{ ownerId: 'owner', identities: [{ provider: 'google' }] }] },
    { ...policy, owners: [...policy.owners, policy.owners[0]] },
    { ...policy, clients: [{ clientId: 'write', access: 'write' }] },
    { ...policy, clients: [{ clientId: 'write', access: 'write', writeScope: 'openid' }] },
    { ...policy, clients: [{ clientId: 'read', access: 'read', writeScope: 'tasks:write' }] },
    { ...policy, typo: true },
  ]) assert.throws(() => configFor(value), statusIs(503, 'auth_not_configured'));
  assert.throws(() => configFor(policy, { WORKOS_API_KEY: '' }), statusIs(503));
  assert.throws(() => configFor(policy, { TASK_BOARD_AUTH_POLICY: '{' }), statusIs(503));
});
