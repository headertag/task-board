import { AuthError, type AuthConfig } from './auth';
import { authJSON } from './auth-json';

export function protectedResourceMetadata(config: AuthConfig) {
  return { resource: config.audience, authorization_servers: [config.issuer], bearer_methods_supported: ['header'], scopes_supported: ['openid', 'profile', 'email'] };
}
// The configured issuer is authoritative. Never fabricate a registration endpoint
// or advertise enabled DCR/CIMD when the provider has not actually enabled it.
export async function authorizationServerMetadata(config: AuthConfig, fetcher: typeof fetch = fetch, oidc = false) {
  const response = await fetcher(new URL(oidc ? '/.well-known/openid-configuration' : '/.well-known/oauth-authorization-server', config.issuer), { redirect: 'error', signal: AbortSignal.timeout(10000), headers: { Accept: 'application/json' } });
  if (!response.ok) throw new AuthError(503, 'auth_discovery_unavailable', 'Authorization discovery is unavailable');
  let metadata: any;
  try { metadata = await authJSON(response); } catch { throw new AuthError(503, 'auth_discovery_unavailable', 'Authorization discovery is unavailable'); }
  if (metadata.issuer !== config.issuer || !metadata.response_types_supported?.includes('code') ||
    (!oidc && !metadata.code_challenge_methods_supported?.includes('S256')) ||
    (oidc && metadata.code_challenge_methods_supported !== undefined && !metadata.code_challenge_methods_supported?.includes('S256'))) throw new AuthError(503, 'auth_discovery_invalid', 'Authorization discovery is unavailable');
  for (const name of ['authorization_endpoint', 'token_endpoint', 'jwks_uri', 'registration_endpoint', 'userinfo_endpoint', 'introspection_endpoint', 'revocation_endpoint', 'end_session_endpoint']) {
    if (metadata[name] === undefined && !['authorization_endpoint', 'token_endpoint'].includes(name)) continue;
    let endpoint: URL;
    try { endpoint = new URL(metadata[name]); } catch { throw new AuthError(503, 'auth_discovery_invalid', 'Authorization discovery is unavailable'); }
    if (endpoint.origin !== config.issuer || endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.hash) throw new AuthError(503, 'auth_discovery_invalid', 'Authorization discovery is unavailable');
  }
  return metadata;
}
