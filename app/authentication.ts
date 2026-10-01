import { env } from 'cloudflare:workers';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { authenticateBearer, readAuthConfig, AuthError, type AuthBindings } from '../lib/auth';
import { browserPrincipal, readBrowserConfig, cookie, SESSION_COOKIE, type BrowserBindings } from '../lib/browser-auth';
import { safeError } from '../lib/operations';

export const authBindings = () => env as unknown as AuthBindings & BrowserBindings;
export function requireMigrationFreeze() {
  if (env.TASK_BOARD_READ_ONLY !== 'true') throw new AuthError(409, 'migration_requires_freeze', 'Freeze board writes before capturing a migration backup');
}
export function browserConfig() { const bindings = authBindings(); return readBrowserConfig(bindings, readAuthConfig(bindings)); }
export async function getBoardPrincipal(request?: Request) {
  const requestHeaders = request?.headers || await headers();
  const readOnly = env.TASK_BOARD_READ_ONLY ?? 'true';
  if (readOnly !== 'true' && readOnly !== 'false') throw new AuthError(503, 'auth_configuration', 'Task board access configuration is invalid');
  const config = readAuthConfig(authBindings());
  // A bad bearer credential never falls back to a more privileged browser cookie.
  let principal;
  if (requestHeaders.has('authorization')) principal = await authenticateBearer(requestHeaders, config);
  else {
    if (!cookie(requestHeaders, SESSION_COOKIE)) return null;
    const browser = readBrowserConfig(authBindings(), config);
    if (request && new URL(request.url).origin !== browser.origin) throw new AuthError(403, 'origin_mismatch', 'Request origin is not allowed');
    principal = await browserPrincipal(requestHeaders, browser);
  }
  return principal && (readOnly === 'true' ? { ...principal, canWrite: false } : principal);
}
export async function requireBoardPrincipal(returnTo: string) {
  try { const principal = await getBoardPrincipal(); if (principal) return principal; }
  catch (error) { if (!(error instanceof AuthError) || error.status !== 401) throw error; }
  redirect('/auth/signin?return_to=' + encodeURIComponent(returnTo));
}
export function authFailure(_request: Request, error: unknown): Response {
  const result = safeError(error);
  const responseHeaders = new Headers({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
  if (result.status === 401) {
    try {
      const config = readAuthConfig(authBindings());
      responseHeaders.set('WWW-Authenticate', `Bearer resource_metadata="${new URL('/.well-known/oauth-protected-resource/mcp', config.audience)}", scope="openid profile email"`);
    } catch { /* Configuration errors never advertise invented authorization endpoints. */ }
  }
  return Response.json(result.body, { status: result.status, headers: responseHeaders });
}
