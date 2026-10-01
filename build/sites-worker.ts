import handler from "vinext/server/fetch-handler";
import { oauthDiscovery } from './oauth-discovery';
import { SESSION_COOKIE } from '../lib/browser-auth';
export default { async fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext) {
  const discovery = await oauthDiscovery(request, env);
  if (discovery) return discovery;
  // Also pin SSR cookie requests, whose component helper has no Request URL.
  if (!request.headers.has('authorization') && (request.headers.get('cookie') || '').split(';').some(value => value.trim().startsWith(SESSION_COOKIE + '=')) && new URL(request.url).origin !== env.TASK_BOARD_ORIGIN) {
    return Response.json({error:{code:'origin_mismatch',message:'Request origin is not allowed'}},{status:403,headers:{'Cache-Control':'private, no-store'}});
  }
  const headers = new Headers(request.headers);
  for (const name of headers.keys()) if (name.startsWith('oai-authenticated-user-')) headers.delete(name);
  const sanitized = new Request(request, { headers });
  return handler.fetch(sanitized, env, ctx);
} };
