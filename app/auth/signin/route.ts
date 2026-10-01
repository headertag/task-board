import { browserConfig, authFailure } from '../../authentication';
import { beginSignIn } from '../../../lib/browser-auth';
import { transactionStore } from '../store';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) { try { return await beginSignIn(request, browserConfig(), transactionStore); } catch (e) { return authFailure(request, e); } }
