import { getBoardPrincipal, authFailure } from '../../authentication';
import { AuthError, requirePermission, type AuthPrincipal } from '../../../lib/auth';
import { database, imageStorage } from '../../../lib/db';
import { BoardService, AppError } from '../../../lib/service';
import { execute } from '../../../lib/operations';

export const dynamic = 'force-dynamic';

const readActions = new Set([
  'get_comment', 'list_comments', 'list_tasks', 'get_task', 'export_tasks',
  'export_backup_page', 'preview_import', 'list_snapshots', 'get_snapshot',
]);
const writeActions = new Set([
  'add_comment', 'edit_comment', 'archive_comment', 'restore_comment',
  'create_task', 'update_task', 'complete_task', 'archive_task', 'restore_task',
  'import_tasks', 'seed_samples',
]);

async function authenticated(request: Request): Promise<AuthPrincipal> {
  const principal = await getBoardPrincipal(request);
  if (!principal) throw new AuthError(401, 'sign_in_required', 'Sign in to access your tasks');
  requirePermission(principal, 'read');
  const origin = request.headers.get('origin');
  if ((origin && origin !== new URL(request.url).origin) || (principal.kind === 'browser' && request.headers.get('sec-fetch-site') === 'cross-site')) {
    throw new AuthError(403, 'origin_mismatch', 'Request origin is not allowed');
  }
  return principal;
}

export async function POST(request: Request) {
  try {
    const principal = await authenticated(request);
    const body = await request.text();
    if (body.length > 1500000) throw new AppError(413, 'too_large', 'Import is too large');
    let input: any;
    try { input = JSON.parse(body); }
    catch { throw new AppError(400, 'invalid_json', 'Request is not valid JSON'); }
    if (!input || Array.isArray(input) || typeof input.name !== 'string' || !input.args || typeof input.args !== 'object' || Array.isArray(input.args)) {
      throw new AppError(400, 'invalid_request', 'Invalid task request');
    }
    if (!readActions.has(input.name) && !writeActions.has(input.name)) throw new AppError(404, 'unknown_action', 'Unknown task action');
    const permission = writeActions.has(input.name) ? 'write' : 'read';
    requirePermission(principal, permission);
    if (permission === 'write' && principal.kind === 'browser' && request.headers.get('origin') !== new URL(request.url).origin) {
      throw new AuthError(403, 'origin_mismatch', 'Request origin is not allowed');
    }
    const result = await execute(new BoardService(database(), principal.ownerId, imageStorage()), input.name, input.args);
    return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return authFailure(request, error); }
}

async function unsupported(request: Request) {
  try {
    await authenticated(request);
    return new Response(null, { status: 405, headers: { Allow: 'POST', 'Cache-Control': 'no-store' } });
  } catch (error) { return authFailure(request, error); }
}
export const GET = unsupported;
export const HEAD = unsupported;
export const PUT = unsupported;
export const PATCH = unsupported;
export const DELETE = unsupported;
export const OPTIONS = unsupported;
