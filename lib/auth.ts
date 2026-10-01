import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey, type JWTPayload } from 'jose';
import { AppError } from './errors';

export { AppError as AuthError } from './errors';

export type IdentityProvider = 'google' | 'github';
export type IdentityRule = {
  provider: IdentityProvider;
  providerId?: string;
  email?: string;
  workosUserId?: string;
};
export type AuthPolicy = {
  version: 1;
  owners: { ownerId: string; identities: IdentityRule[] }[];
  clients: { clientId: string; access: 'read' | 'write'; writeScope?: string }[];
};
export type AuthBindings = {
  WORKOS_AUTHKIT_ISSUER?: string;
  WORKOS_MCP_AUDIENCE?: string;
  WORKOS_API_KEY?: string;
  TASK_BOARD_AUTH_POLICY?: string;
};
export type AuthConfig = {
  issuer: string;
  audience: string;
  apiKey: string;
  policy: AuthPolicy;
};
export type AuthContext =
  | { kind: 'browser' }
  | { kind: 'connect'; clientId: string; consentId: string; scopes: string[] };
export type AuthPrincipal = {
  /** The explicitly mapped, existing storage owner, never an OAuth client label. */
  ownerId: string;
  /** Storage compatibility alias. This is deliberately not the WorkOS subject. */
  userId: string;
  workosUserId: string;
  email: string;
  displayName: string;
  kind: 'browser' | 'connect';
  canWrite: boolean;
  clientId?: string;
  consentId?: string;
  scopes: string[];
};
/** Server-side test seams; never populate these from request input. */
export type AuthDependencies = {
  fetch?: typeof fetch;
  key?: JWTVerifyGetKey;
  currentDate?: Date;
};

const OIDC_SCOPES = new Set(['openid', 'profile', 'email', 'offline_access']);
const remoteKeys = new Map<string, JWTVerifyGetKey>();

function configurationError(): never {
  throw new AppError(503, 'auth_not_configured', 'Task board authentication is not configured');
}
function invalidToken(): never {
  throw new AppError(401, 'invalid_token', 'The access token is invalid or expired');
}
function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function nonempty(value: unknown, max = 512): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max &&
    value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
}
function keysAre(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key));
}
function emailAddress(value: unknown): value is string {
  return nonempty(value, 320) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}
function httpsUrl(value: unknown, originOnly = false): string {
  if (!nonempty(value, 2048)) return configurationError();
  let url: URL;
  try { url = new URL(value); } catch { return configurationError(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
    (originOnly && url.pathname !== '/')) return configurationError();
  return originOnly ? url.origin : value;
}

/** Parse the private Worker binding anew so allowlist changes apply on every request. */
export function readAuthConfig(bindings: AuthBindings): AuthConfig {
  const issuer = httpsUrl(bindings.WORKOS_AUTHKIT_ISSUER, true);
  const audience = httpsUrl(bindings.WORKOS_MCP_AUDIENCE);
  if (!nonempty(bindings.WORKOS_API_KEY, 4096) || !nonempty(bindings.TASK_BOARD_AUTH_POLICY, 100_000)) {
    return configurationError();
  }
  let raw: unknown;
  try { raw = JSON.parse(bindings.TASK_BOARD_AUTH_POLICY); } catch { return configurationError(); }
  if (!record(raw) || !keysAre(raw, ['version', 'owners', 'clients']) || raw.version !== 1 ||
    !Array.isArray(raw.owners) || !Array.isArray(raw.clients) || raw.owners.length > 1000 || raw.clients.length > 1000) {
    return configurationError();
  }
  const ownerIds = new Set<string>();
  const selectors = new Set<string>();
  const owners = raw.owners.map(owner => {
    if (!record(owner) || !keysAre(owner, ['ownerId', 'identities']) || !nonempty(owner.ownerId, 200) ||
      ownerIds.has(owner.ownerId) || !Array.isArray(owner.identities) || owner.identities.length === 0 || owner.identities.length > 100) {
      return configurationError();
    }
    ownerIds.add(owner.ownerId);
    const identities = owner.identities.map(identity => {
      if (!record(identity) || !keysAre(identity, ['provider', 'providerId', 'email', 'workosUserId']) ||
        (identity.provider !== 'google' && identity.provider !== 'github') ||
        (identity.providerId !== undefined && !nonempty(identity.providerId, 256)) ||
        (identity.email !== undefined && !emailAddress(identity.email)) ||
        (identity.workosUserId !== undefined && (!nonempty(identity.workosUserId, 200) || !identity.workosUserId.startsWith('user_'))) ||
        (identity.providerId === undefined && identity.email === undefined) ||
        // GitHub names and email addresses are mutable; pin its immutable provider ID.
        (identity.provider === 'github' && identity.providerId === undefined)) {
        return configurationError();
      }
      const rule: IdentityRule = {
        provider: identity.provider,
        ...(identity.providerId !== undefined ? { providerId: identity.providerId as string } : {}),
        ...(identity.email !== undefined ? { email: (identity.email as string).toLowerCase() } : {}),
        ...(identity.workosUserId !== undefined ? { workosUserId: identity.workosUserId as string } : {}),
      };
      const selector = JSON.stringify(rule);
      if (selectors.has(selector)) return configurationError();
      selectors.add(selector);
      return rule;
    });
    return { ownerId: owner.ownerId, identities };
  });
  const clientIds = new Set<string>();
  const clients = raw.clients.map(client => {
    if (!record(client) || !keysAre(client, ['clientId', 'access', 'writeScope']) || !nonempty(client.clientId, 2048) ||
      /\s/.test(client.clientId) || clientIds.has(client.clientId) || (client.access !== 'read' && client.access !== 'write') ||
      (client.writeScope !== undefined && (!nonempty(client.writeScope, 128) || /\s/.test(client.writeScope) || OIDC_SCOPES.has(client.writeScope))) ||
      (client.access === 'write' && client.writeScope === undefined) ||
      (client.access === 'read' && client.writeScope !== undefined)) {
      return configurationError();
    }
    clientIds.add(client.clientId);
    return {
      clientId: client.clientId,
      access: client.access as 'read' | 'write',
      ...(client.writeScope !== undefined ? { writeScope: client.writeScope as string } : {}),
    };
  });
  return { issuer, audience, apiKey: bindings.WORKOS_API_KEY, policy: { version: 1, owners, clients } };
}

function jwks(config: AuthConfig, dependencies: AuthDependencies): JWTVerifyGetKey {
  if (dependencies.key) return dependencies.key;
  let key = remoteKeys.get(config.issuer);
  if (!key) {
    key = createRemoteJWKSet(new URL('/oauth2/jwks', config.issuer), {
      timeoutDuration: 5000, cooldownDuration: 30_000, cacheMaxAge: 300_000,
    });
    if (remoteKeys.size >= 8) remoteKeys.delete(remoteKeys.keys().next().value!);
    remoteKeys.set(config.issuer, key);
  }
  return key;
}

async function verifyToken(token: string, config: AuthConfig, audience: string, dependencies: AuthDependencies): Promise<JWTPayload> {
  if (!nonempty(token, 16_384)) return invalidToken();
  try {
    const { payload } = await jwtVerify(token, jwks(config, dependencies), {
      issuer: config.issuer,
      audience,
      algorithms: ['RS256'],
      requiredClaims: ['iss', 'aud', 'sub', 'iat', 'exp'],
      clockTolerance: 0,
      ...(dependencies.currentDate ? { currentDate: dependencies.currentDate } : {}),
    });
    if (!nonempty(payload.sub, 200) || !payload.sub.startsWith('user_') ||
      !Number.isSafeInteger(payload.exp) || !Number.isSafeInteger(payload.iat) ||
      payload.exp! <= payload.iat! || payload.iat! > Math.floor((dependencies.currentDate?.getTime() ?? Date.now()) / 1000) ||
      payload.act !== undefined) return invalidToken();
    return payload;
  } catch { return invalidToken(); }
}

/** Connect access tokens require a user consent, a client, and this exact resource. */
export async function authenticateBearer(headers: Headers, config: AuthConfig, dependencies: AuthDependencies = {}): Promise<AuthPrincipal> {
  const authorization = headers.get('authorization');
  if (!authorization) throw new AppError(401, 'sign_in_required', 'Sign in to access your tasks');
  const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(authorization);
  if (!match) return invalidToken();
  const claims = await verifyToken(match[1], config, config.audience, dependencies);
  if (!nonempty(claims.client_id, 2048) || /\s/.test(claims.client_id) ||
    !nonempty(claims.sid, 200) ||
    (claims.scope !== undefined && typeof claims.scope !== 'string')) return invalidToken();
  return authorizeWorkosUser(claims.sub!, config, {
    kind: 'connect', clientId: claims.client_id, consentId: claims.sid,
    scopes: typeof claims.scope === 'string' ? claims.scope.split(' ').filter(Boolean) : [],
  }, dependencies);
}

/** At the browser callback, validate the ID token against the sealed PKCE transaction. */
export async function verifyBrowserIdToken(token: string, config: AuthConfig, expected: { clientId: string; nonce: string }, dependencies: AuthDependencies = {}): Promise<{ sub: string; issuer: string; audience: string; expiresAt: number }> {
  if (!nonempty(expected.clientId, 2048) || !nonempty(expected.nonce, 512)) return invalidToken();
  const claims = await verifyToken(token, config, expected.clientId, dependencies);
  if (claims.nonce !== expected.nonce ||
    (claims.azp !== undefined && claims.azp !== expected.clientId) ||
    (Array.isArray(claims.aud) && claims.aud.length > 1 && claims.azp !== expected.clientId)) return invalidToken();
  return { sub: claims.sub!, issuer: config.issuer, audience: expected.clientId, expiresAt: claims.exp! };
}

type WorkosIdentity = { provider: IdentityProvider; providerId: string };
type WorkosUser = { id: string; email: string; emailVerified: boolean; name: string; identities: WorkosIdentity[] };

async function boundedJson(response: Response): Promise<unknown> {
  const maximum = 65_536;
  const contentLength = response.headers.get('content-length');
  if ((contentLength && Number(contentLength) > maximum) || !response.body) throw new Error('Invalid identity response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) {
        await reader.cancel();
        throw new Error('Identity response is too large');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

async function lookupWorkosUser(subject: string, config: AuthConfig, dependencies: AuthDependencies): Promise<WorkosUser> {
  const request = dependencies.fetch ?? fetch;
  const get = async (path: string): Promise<unknown> => {
    try {
      const url = `https://api.workos.com/user_management/users/${encodeURIComponent(subject)}${path}`;
      const response = await request(url, {
        headers: { Authorization: `Bearer ${config.apiKey}`, Accept: 'application/json' },
        // Workers supports manual redirects; reject them here before any API
        // credential can be forwarded to another origin or identity endpoint.
        redirect: 'manual', signal: AbortSignal.timeout(5000),
      });
      if (response.status < 200 || response.status >= 300 || response.redirected ||
        (response.url && response.url !== url)) throw new Error('Identity lookup failed');
      return await boundedJson(response);
    } catch {
      throw new AppError(503, 'auth_unavailable', 'Identity verification is temporarily unavailable');
    }
  };
  const [user, identities] = await Promise.all([get(''), get('/identities')]);
  if (!record(user) || user.id !== subject || !emailAddress(user.email) ||
    typeof user.email_verified !== 'boolean' || !Array.isArray(identities) || identities.length > 100) {
    throw new AppError(503, 'auth_unavailable', 'Identity verification is temporarily unavailable');
  }
  const social: WorkosIdentity[] = [];
  for (const identity of identities) {
    if (!record(identity)) throw new AppError(503, 'auth_unavailable', 'Identity verification is temporarily unavailable');
    if (identity.type !== 'OAuth' || (identity.provider !== 'GoogleOAuth' && identity.provider !== 'GithubOAuth')) continue;
    if (!nonempty(identity.idp_id, 256)) throw new AppError(503, 'auth_unavailable', 'Identity verification is temporarily unavailable');
    social.push({ provider: identity.provider === 'GoogleOAuth' ? 'google' : 'github', providerId: identity.idp_id });
  }
  const name = nonempty(user.name, 500) ? user.name : [user.first_name, user.last_name].filter(part => nonempty(part, 250)).join(' ');
  return { id: subject, email: user.email.toLowerCase(), emailVerified: user.email_verified, name, identities: social };
}

/** Browser callers must obtain the subject from a verified, sealed session, never headers. */
export async function authorizeWorkosUser(workosUserId: string, config: AuthConfig, context: AuthContext, dependencies: AuthDependencies = {}): Promise<AuthPrincipal> {
  if (!nonempty(workosUserId, 200) || !workosUserId.startsWith('user_')) return invalidToken();
  const user = await lookupWorkosUser(workosUserId, config, dependencies);
  const matches = config.policy.owners.filter(owner => owner.identities.some(rule =>
    (!rule.workosUserId || rule.workosUserId === user.id) &&
    (!rule.email || (user.emailVerified && rule.email === user.email)) &&
    user.identities.some(identity => identity.provider === rule.provider && (!rule.providerId || identity.providerId === rule.providerId)),
  ));
  // An ambiguous map fails closed instead of moving a user between existing boards.
  if (matches.length !== 1) throw new AppError(403, 'identity_not_allowed', 'This identity is not allowed to access the task board');
  const ownerId = matches[0].ownerId;
  let canWrite = context.kind === 'browser';
  if (context.kind === 'connect') {
    if (!nonempty(context.clientId, 2048) || !nonempty(context.consentId, 200)) return invalidToken();
    const client = config.policy.clients.find(candidate => candidate.clientId === context.clientId);
    // Dynamic clients' standard OIDC scopes do not grant task mutations.
    canWrite = client?.access === 'write' && Boolean(client.writeScope && context.scopes.includes(client.writeScope));
  }
  return {
    ownerId, userId: ownerId, workosUserId: user.id, email: user.email,
    displayName: user.name || user.email, kind: context.kind, canWrite,
    scopes: context.kind === 'connect' ? [...context.scopes] : [],
    ...(context.kind === 'connect' ? { clientId: context.clientId, consentId: context.consentId } : {}),
  };
}

export function requirePermission(principal: AuthPrincipal, permission: 'read' | 'write'): void {
  if (permission === 'write' && !principal.canWrite) {
    throw new AppError(403, 'permission_denied', 'This client has read-only access to your tasks');
  }
}
