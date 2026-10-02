import { browserConfig, boardAuthDependencies, authFailure } from '../../authentication';
import { finishSignIn, setCookie, TRANSACTION_COOKIE } from '../../../lib/browser-auth';
import { transactionStore } from '../store';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) { try { return await finishSignIn(request, browserConfig(), transactionStore, boardAuthDependencies()); } catch (e) { const response = authFailure(request, e); response.headers.append('Set-Cookie', setCookie(TRANSACTION_COOKIE, '', 0)); return response; } }
