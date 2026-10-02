import { z } from 'zod';
import { getBoardPrincipal, authFailure, authBindings } from '../../authentication';
import { AuthError, readAuthConfig, requirePermission, type AuthPrincipal } from '../../../lib/auth';
import { AccessStore, normalizeAccessEmail } from '../../../lib/access';
import { database } from '../../../lib/db';

export const dynamic = 'force-dynamic';
const allowInput = z.object({ action: z.literal('allow'), email: z.unknown(), access: z.enum(['read', 'write']) }).strict();
const revokeInput = z.object({ action: z.literal('revoke'), email: z.unknown() }).strict();

async function manager(request: Request): Promise<AuthPrincipal> {
  const principal = await getBoardPrincipal(request);
  if (!principal) throw new AuthError(401, 'sign_in_required', 'Sign in to manage board access');
  requirePermission(principal, 'read');
  if (principal.kind !== 'browser' || !principal.canManageAccess) {
    throw new AuthError(403, 'access_management_denied', 'Only the board owner can manage access');
  }
  const origin = request.headers.get('origin');
  if ((origin && origin !== new URL(request.url).origin) || request.headers.get('sec-fetch-site') === 'cross-site') {
    throw new AuthError(403, 'origin_mismatch', 'Request origin is not allowed');
  }
  return principal;
}

async function members(principal: AuthPrincipal) {
  const policy = readAuthConfig(authBindings()).policy;
  const bootstrap = new Map<string, { email: string; access: 'write'; active: true; bound: boolean; bootstrap: true }>();
  for (const owner of policy.owners.filter(owner => owner.ownerId === principal.ownerId)) {
    for (const rule of owner.identities) if (rule.email) {
      const email = normalizeAccessEmail(rule.email);
      bootstrap.set(email, { email, access: 'write', active: true, bound: Boolean(rule.providerId && rule.workosUserId), bootstrap: true });
    }
  }
  const saved = await new AccessStore(database()).list(principal.ownerId);
  return { members: [...bootstrap.values(), ...saved.filter(member => !bootstrap.has(member.email))] };
}

export async function GET(request: Request) {
  try {
    return Response.json(await members(await manager(request)), { headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
  } catch (error) { return authFailure(request, error); }
}

async function input(request: Request) {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new AuthError(415, 'invalid_access_request', 'Send a JSON access request');
  }
  const reader = request.body?.getReader();
  if (!reader) throw new AuthError(400, 'invalid_access_request', 'Invalid access request');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 4096) { await reader.cancel(); throw new AuthError(413, 'invalid_access_request', 'Access request is too large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  let value: unknown;
  try {
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch { throw new AuthError(400, 'invalid_access_request', 'Invalid access request'); }
  const parsed = z.union([allowInput, revokeInput]).safeParse(value);
  if (!parsed.success) throw new AuthError(400, 'invalid_access_request', 'Choose an email address and read or write access');
  return parsed.data;
}

export async function POST(request: Request) {
  try {
    const principal = await manager(request);
    requirePermission(principal, 'write');
    if (request.headers.get('origin') !== new URL(request.url).origin) throw new AuthError(403, 'origin_mismatch', 'Request origin is not allowed');
    const data = await input(request), email = normalizeAccessEmail(data.email);
    // Static identity policy stays protected and is never rewritten by the UI.
    if (readAuthConfig(authBindings()).policy.owners.some(owner => owner.identities.some(rule => rule.email && normalizeAccessEmail(rule.email) === email))) {
      throw new AuthError(400, 'bootstrap_access_protected', 'Configured owner access cannot be changed here');
    }
    const store = new AccessStore(database());
    if (data.action === 'allow') await store.allow({ ownerId: principal.ownerId, email, access: data.access, actorWorkosUserId: principal.workosUserId });
    else await store.revoke({ ownerId: principal.ownerId, email, actorWorkosUserId: principal.workosUserId });
    return Response.json(await members(principal), { headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
  } catch (error) { return authFailure(request, error); }
}

async function unsupported(request: Request) {
  try {
    await manager(request);
    return new Response(null, { status: 405, headers: { Allow: 'GET, POST', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
  } catch (error) { return authFailure(request, error); }
}
export const HEAD = unsupported;
export const PUT = unsupported;
export const PATCH = unsupported;
export const DELETE = unsupported;
export const OPTIONS = unsupported;
