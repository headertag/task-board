import { AuthError, authorizeWorkosUser, verifyBrowserIdToken, type AuthConfig, type AuthDependencies } from './auth';
import { authJSON } from './auth-json';

export const SESSION_COOKIE = '__Host-task_board_session';
export const TRANSACTION_COOKIE = '__Host-task_board_oauth';
const decoder = new TextDecoder();
const encoder = new TextEncoder();
export type BrowserBindings = { TASK_BOARD_ORIGIN?: string; WORKOS_BROWSER_CLIENT_ID?: string; TASK_BOARD_SESSION_SECRET?: string };
export type BrowserConfig = { origin: string; clientId: string; secret: string; auth: AuthConfig };
export type TransactionStore = { put(key: string, expiresAt: number): Promise<void>; consume(key: string, now: number): Promise<boolean> };
type Transaction = { state: string; nonce: string; verifier: string; returnTo: string; expiresAt: number; origin: string; issuer: string; clientId: string };

export function readBrowserConfig(bindings: BrowserBindings, auth: AuthConfig): BrowserConfig {
  let origin: URL;
  try { origin = new URL(bindings.TASK_BOARD_ORIGIN || ''); } catch { throw new AuthError(503, 'auth_configuration', 'Browser authentication is unavailable'); }
  if (origin.protocol !== 'https:' || origin.origin !== bindings.TASK_BOARD_ORIGIN || origin.hostname.includes('*') ||
    !bindings.WORKOS_BROWSER_CLIENT_ID || !/^[A-Za-z0-9_-]{1,200}$/.test(bindings.WORKOS_BROWSER_CLIENT_ID) ||
    !/^[A-Za-z0-9_-]{43}$/.test(bindings.TASK_BOARD_SESSION_SECRET || '')) {
    throw new AuthError(503, 'auth_configuration', 'Browser authentication is unavailable');
  }
  return { origin: origin.origin, clientId: bindings.WORKOS_BROWSER_CLIENT_ID, secret: bindings.TASK_BOARD_SESSION_SECRET!, auth };
}

export function safeReturnTo(value: string | null): string {
  if (!value?.startsWith('/') || value.startsWith('//')) return '/';
  let url: URL;
  try { url = new URL(value, 'https://board.example'); } catch { return '/'; }
  if (url.origin !== 'https://board.example' || url.pathname.startsWith('/auth/')) return '/';
  return url.pathname + url.search + url.hash;
}

function base64url(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function bytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid encoding');
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), x => x.charCodeAt(0));
}
function random(): string { return base64url(crypto.getRandomValues(new Uint8Array(32))); }
async function digest(value: string): Promise<string> { return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))); }
async function key(config: BrowserConfig): Promise<CryptoKey> { return crypto.subtle.importKey('raw', bytes(config.secret) as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']); }
export async function seal(value: unknown, purpose: 'session'|'transaction', config: BrowserConfig): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(`${purpose}:${config.origin}:${config.clientId}`) }, await key(config), encoder.encode(JSON.stringify(value)));
  return base64url(iv) + '.' + base64url(new Uint8Array(ciphertext));
}
export async function unseal(value: string, purpose: 'session'|'transaction', config: BrowserConfig): Promise<any> {
  try {
    if (value.length > 3800) throw new Error();
    const parts = value.split('.');
    if (parts.length !== 2) throw new Error();
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(parts[0]) as BufferSource, additionalData: encoder.encode(`${purpose}:${config.origin}:${config.clientId}`) }, await key(config), bytes(parts[1]) as BufferSource);
    return JSON.parse(decoder.decode(plaintext));
  } catch { throw new AuthError(401, 'invalid_session', 'Sign in again'); }
}
export function cookie(headers: Headers, name: string): string | null {
  const values = (headers.get('cookie') || '').split(';').map(v => v.trim()).filter(v => v.startsWith(name + '='));
  if (values.length > 1) throw new AuthError(401, 'invalid_session', 'Sign in again');
  return values.length ? values[0].slice(name.length + 1) : null;
}
export function setCookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}
function requireOrigin(request: Request, config: BrowserConfig): void {
  if (new URL(request.url).origin !== config.origin) throw new AuthError(403, 'origin_mismatch', 'Request origin is not allowed');
}
export async function beginSignIn(request: Request, config: BrowserConfig, store: TransactionStore, now = Math.floor(Date.now()/1000)): Promise<Response> {
  requireOrigin(request, config);
  const topLevelNavigation = request.headers.get('sec-fetch-mode') === 'navigate' && request.headers.get('sec-fetch-dest') === 'document' && request.headers.get('sec-fetch-user') === '?1';
  if ((request.headers.has('origin') && request.headers.get('origin') !== config.origin) || (request.headers.get('sec-fetch-site') === 'cross-site' && !topLevelNavigation)) throw new AuthError(403, 'origin_mismatch', 'Request origin is not allowed');
  const transaction: Transaction = { state: random(), nonce: random(), verifier: random(), returnTo: safeReturnTo(new URL(request.url).searchParams.get('return_to')), expiresAt: now + 600, origin: config.origin, issuer: config.auth.issuer, clientId: config.clientId };
  await store.put(await digest(transaction.state), transaction.expiresAt);
  const authorize = new URL('/oauth2/authorize', config.auth.issuer);
  authorize.search = new URLSearchParams({ response_type: 'code', client_id: config.clientId, redirect_uri: config.origin + '/auth/callback', scope: 'openid profile email', state: transaction.state, nonce: transaction.nonce, code_challenge: await digest(transaction.verifier), code_challenge_method: 'S256', resource: config.auth.audience }).toString();
  return new Response(null, { status: 302, headers: { Location: authorize.href, 'Cache-Control': 'private, no-store', 'Set-Cookie': setCookie(TRANSACTION_COOKIE, await seal(transaction, 'transaction', config), 600) } });
}
export async function finishSignIn(request: Request, config: BrowserConfig, store: TransactionStore, deps: AuthDependencies & { fetch?: typeof fetch } = {}, now = Math.floor(Date.now()/1000)): Promise<Response> {
  requireOrigin(request, config);
  const url = new URL(request.url);
  const value = cookie(request.headers, TRANSACTION_COOKIE);
  if (!value) throw new AuthError(401, 'invalid_oauth_state', 'Sign in again');
  const tx = await unseal(value, 'transaction', config) as Transaction;
  if (tx.expiresAt <= now || tx.expiresAt > now + 600 || tx.origin !== config.origin || tx.issuer !== config.auth.issuer || tx.clientId !== config.clientId || !tx.state || !tx.nonce || !tx.verifier || url.searchParams.getAll('state').length !== 1 || url.searchParams.get('state') !== tx.state || url.searchParams.getAll('code').length !== 1 || !url.searchParams.get('code') || url.searchParams.has('error')) throw new AuthError(401, 'invalid_oauth_state', 'Sign in again');
  if (!await store.consume(await digest(tx.state), now)) throw new AuthError(401, 'invalid_oauth_state', 'Sign in again');
  const endpoint = new URL('/oauth2/token', config.auth.issuer);
  // Workers supports manual/follow, but rejects redirect: 'error'. Manual keeps
  // the authorization code and verifier at the exact configured endpoint.
  const response = await (deps.fetch || fetch)(endpoint, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10000), headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: url.searchParams.get('code')!, client_id: config.clientId, redirect_uri: config.origin + '/auth/callback', code_verifier: tx.verifier, resource: config.auth.audience }) });
  if (!response.ok || response.redirected || (response.url && response.url !== endpoint.href)) throw new AuthError(401, 'oauth_failed', 'Sign in again');
  let tokens: any;
  try { tokens = await authJSON(response, 32000); } catch { throw new AuthError(401, 'oauth_failed', 'Sign in again'); }
  if (typeof tokens.id_token !== 'string') throw new AuthError(401, 'oauth_failed', 'Sign in again');
  const verified = await verifyBrowserIdToken(tokens.id_token, config.auth, { clientId: config.clientId, nonce: tx.nonce }, deps);
  await authorizeWorkosUser(verified.sub, config.auth, { kind: 'browser' }, deps);
  const expiresAt = Math.min(verified.expiresAt, now + 3600);
  if (expiresAt <= now) throw new AuthError(401, 'invalid_session', 'Sign in again');
  const headers = new Headers({ Location: safeReturnTo(tx.returnTo), 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' });
  headers.append('Set-Cookie', setCookie(TRANSACTION_COOKIE, '', 0));
  headers.append('Set-Cookie', setCookie(SESSION_COOKIE, await seal({ ...verified, expiresAt }, 'session', config), expiresAt - now));
  return new Response(null, { status: 303, headers });
}
export async function browserPrincipal(headers: Headers, config: BrowserConfig, deps: AuthDependencies = {}, now = Math.floor(Date.now()/1000)) {
  const value = cookie(headers, SESSION_COOKIE);
  if (!value) return null;
  const session = await unseal(value, 'session', config);
  if (!Number.isSafeInteger(session.expiresAt) || session.expiresAt <= now || session.expiresAt > now + 3600 || session.issuer !== config.auth.issuer || session.audience !== config.clientId || typeof session.sub !== 'string') throw new AuthError(401, 'invalid_session', 'Sign in again');
  return authorizeWorkosUser(session.sub, config.auth, { kind: 'browser' }, deps);
}
export function signOut(request: Request, config: BrowserConfig): Response {
  requireOrigin(request, config);
  if (request.headers.get('origin') !== config.origin || request.headers.get('sec-fetch-site') === 'cross-site') throw new AuthError(403, 'origin_mismatch', 'Request origin is not allowed');
  const headers = new Headers({ Location: '/', 'Cache-Control': 'private, no-store' });
  headers.append('Set-Cookie', setCookie(SESSION_COOKIE, '', 0));
  headers.append('Set-Cookie', setCookie(TRANSACTION_COOKIE, '', 0));
  return new Response(null, { status: 303, headers });
}
