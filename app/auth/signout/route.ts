import { browserConfig, authFailure } from '../../authentication';
import { signOut } from '../../../lib/browser-auth';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) { try { return signOut(request, browserConfig()); } catch (e) { return authFailure(request, e); } }
