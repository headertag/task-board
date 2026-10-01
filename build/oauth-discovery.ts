import { readAuthConfig, type AuthBindings } from '../lib/auth';
import { authorizationServerMetadata, protectedResourceMetadata } from '../lib/oauth-metadata';
import { AppError } from '../lib/errors';

const protectedPaths = new Set(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']);
const serverPaths = new Set(['/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/mcp']);
// Hidden App Router directories are omitted by the current adapter. Serve the
// standards-required well-known paths in the retained Worker entry point.
export async function oauthDiscovery(request: Request, bindings: AuthBindings, fetcher: typeof fetch = fetch): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  const oidc = path === '/.well-known/openid-configuration';
  if (!protectedPaths.has(path) && !serverPaths.has(path) && !oidc) return null;
  if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' } });
  try {
    const config = readAuthConfig(bindings);
    const result = protectedPaths.has(path) ? protectedResourceMetadata(config) : await authorizationServerMetadata(config, fetcher, oidc);
    return new Response(request.method === 'HEAD' ? null : JSON.stringify(result), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
  } catch (error) {
    return Response.json({ error: { code: error instanceof AppError ? error.code : 'auth_discovery_unavailable', message: 'Authorization discovery is unavailable' } }, { status: error instanceof AppError ? error.status : 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
