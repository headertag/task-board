import path from 'node:path';
import { fileURLToPath } from 'node:url';

function ensure(condition, message) { if (!condition) throw new Error(message); }
export async function smokeProduction({ origin, audience = origin + '/mcp', issuer }, request = fetch) {
  async function get(route, options = {}) {
    const url = new URL(route, origin).href;
    const response = await request(url, { ...options, redirect: 'manual', signal: AbortSignal.timeout(15000) });
    ensure(!response.redirected && (!response.url || response.url === url), 'Smoke check rejected a changed response URL');
    return response;
  }
  const resourceResponse = await get('/.well-known/oauth-protected-resource/mcp');
  ensure(resourceResponse.status === 200, 'Protected-resource discovery is unavailable');
  const resource = await resourceResponse.json();
  ensure(resource.resource === audience && JSON.stringify(resource.authorization_servers) === JSON.stringify([issuer]), 'Production resource or issuer discovery does not match configuration');
  const serverResponse = await get('/.well-known/oauth-authorization-server');
  ensure(serverResponse.status === 200, 'Authorization-server discovery is unavailable');
  const server = await serverResponse.json();
  ensure(server.issuer === issuer && server.code_challenge_methods_supported?.includes('S256'), 'Production authorization metadata lacks the approved issuer or PKCE');
  for (const endpoint of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
    if (endpoint === 'jwks_uri' && server[endpoint] === undefined) continue;
    let target;
    try { target = new URL(server[endpoint]); } catch { throw new Error('Production authorization metadata has an invalid endpoint'); }
    ensure(target.protocol === 'https:' && target.origin === issuer, 'Production authorization metadata has a foreign endpoint');
  }
  for (const [route, options] of [
    ['/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) }],
    ['/api/board', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'list_tasks', args: {} }) }],
    ['/api/images?id=not-a-record', {}],
  ]) {
    const response = await get(route, options);
    ensure(response.status === 401 && response.headers.get('Cache-Control')?.includes('no-store'), 'An anonymous protected route did not fail closed');
    ensure(response.headers.get('WWW-Authenticate')?.includes(`resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`), 'Production authentication challenge has the wrong discovery URL');
  }
  const browser = await get('/');
  ensure([302, 303, 307, 308].includes(browser.status), 'Anonymous browser did not redirect to sign-in');
  const location = new URL(browser.headers.get('Location') || '', origin);
  ensure(location.origin === origin && location.pathname === '/auth/signin', 'Anonymous browser has an unexpected sign-in destination');
  return { origin, mcp: audience, smoke: 'passed' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const origin = process.env.TASK_BOARD_PRODUCTION_ORIGIN;
    const issuer = process.env.WORKOS_AUTHKIT_ISSUER;
    if (!origin || !issuer) throw new Error('TASK_BOARD_PRODUCTION_ORIGIN and WORKOS_AUTHKIT_ISSUER are required');
    console.log(JSON.stringify(await smokeProduction({ origin, issuer })));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
