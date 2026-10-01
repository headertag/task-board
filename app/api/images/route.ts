import { getBoardPrincipal, authFailure } from '../../authentication';
import { AuthError, requirePermission, type AuthPrincipal } from '../../../lib/auth';
import { database, imageStorage } from '../../../lib/db';
import { BoardService, AppError } from '../../../lib/service';
import { boundedBytes, IMAGE_LIMIT } from '../../../lib/image';

export const dynamic = 'force-dynamic';
const privateHeaders = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin', 'Referrer-Policy': 'no-referrer' };

async function authenticated(request: Request, permission: 'read' | 'write'): Promise<AuthPrincipal> {
  const principal = await getBoardPrincipal(request);
  if (!principal) throw new AuthError(401, 'sign_in_required', 'Sign in to access images');
  requirePermission(principal, permission);
  const origin = request.headers.get('origin');
  if ((origin && origin !== new URL(request.url).origin) || (principal.kind === 'browser' && request.headers.get('sec-fetch-site') === 'cross-site')) {
    throw new AuthError(403, 'origin_mismatch', 'Request origin is not allowed');
  }
  if (permission === 'write' && principal.kind === 'browser' && origin !== new URL(request.url).origin) {
    throw new AuthError(403, 'origin_mismatch', 'Upload origin is not allowed');
  }
  return principal;
}

function failure(request: Request, error: unknown): Response {
  const response = authFailure(request, error);
  for (const [name, value] of Object.entries(privateHeaders)) response.headers.set(name, value);
  return response;
}

export async function GET(request: Request) {
  try {
    const principal = await authenticated(request, 'read');
    const service = new BoardService(database(), principal.ownerId, imageStorage());
    const id = new URL(request.url).searchParams.get('id') || '';
    const { metadata, object } = await service.activity.image(id);
    return new Response(object.body, { headers: { ...privateHeaders, 'Content-Type': 'image/png', 'Content-Length': String(metadata.size), 'Content-Disposition': 'inline; filename="task-image.png"' } });
  } catch (error) { return failure(request, error); }
}

export async function POST(request: Request) {
  try {
    const principal = await authenticated(request, 'write');
    if (request.headers.get('content-type') !== 'image/png' || !request.body) throw new AppError(400, 'invalid_image', 'Upload a normalized PNG image');
    const bytes = await boundedBytes(request.body, IMAGE_LIMIT);
    let filename: string;
    try { filename = decodeURIComponent(request.headers.get('x-file-name') || 'image.png'); }
    catch { throw new AppError(400, 'invalid_image', 'Image filename is not valid'); }
    const service = new BoardService(database(), principal.ownerId, imageStorage());
    const attachment = await service.activity.upload(request.headers.get('x-task-id') || '', request.headers.get('x-upload-key') || '', bytes, filename);
    return Response.json({ attachment }, { headers: privateHeaders });
  } catch (error) { return failure(request, error); }
}

async function unsupported(request: Request) {
  try {
    await authenticated(request, 'read');
    return new Response(null, { status: 405, headers: { ...privateHeaders, Allow: 'GET, POST' } });
  } catch (error) { return failure(request, error); }
}
export const HEAD = unsupported;
export const PUT = unsupported;
export const PATCH = unsupported;
export const DELETE = unsupported;
export const OPTIONS = unsupported;
