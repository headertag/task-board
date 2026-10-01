import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

function ensure(condition, message) { if (!condition) throw new Error(message); }
const transientDiscoveryStatuses = new Set([404, 429, 502, 503, 504]);
export async function smokeProduction({ origin, audience = origin + '/mcp', issuer }, request = fetch, {
  now = () => performance.now(), wait = delay, readinessTimeoutMs = 60_000, retryDelayMs = 2000,
} = {}) {
  ensure(Number.isSafeInteger(readinessTimeoutMs) && readinessTimeoutMs > 0 && readinessTimeoutMs <= 60_000 &&
    Number.isSafeInteger(retryDelayMs) && retryDelayMs > 0, 'Invalid production readiness retry configuration');
  // Both public discovery documents share one budget, including request time.
  const readinessDeadline = now() + readinessTimeoutMs;
  async function get(route, options = {}, timeoutMs = 15000) {
    const url = new URL(route, origin).href;
    const response = await request(url, { ...options, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    ensure(!response.redirected && (!response.url || response.url === url), 'Smoke check rejected a changed response URL');
    return response;
  }
  async function discovery(route, name) {
    for (;;) {
      const remaining = readinessDeadline - now();
      ensure(remaining > 0, `${name} is unavailable after the production readiness budget`);
      const response = await get(route, {}, Math.max(1, Math.ceil(Math.min(15000, remaining))));
      if (!transientDiscoveryStatuses.has(response.status)) return response;
      await response.body?.cancel();
      const remainingAfterRequest = readinessDeadline - now();
      ensure(remainingAfterRequest > 0, `${name} is unavailable after the production readiness budget`);
      await wait(Math.min(retryDelayMs, remainingAfterRequest));
    }
  }
  const resourceResponse = await discovery('/.well-known/oauth-protected-resource/mcp', 'Protected-resource discovery');
  ensure(resourceResponse.status === 200, 'Protected-resource discovery is unavailable');
  const resource = await resourceResponse.json();
  ensure(resource.resource === audience && JSON.stringify(resource.authorization_servers) === JSON.stringify([issuer]), 'Production resource or issuer discovery does not match configuration');
  const serverResponse = await discovery('/.well-known/oauth-authorization-server', 'Authorization-server discovery');
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
