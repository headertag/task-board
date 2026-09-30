import { getChatGPTUser } from '../../chatgpt-auth';
import { database } from '../../../lib/db';
import { BoardService,AppError } from '../../../lib/service';
import { execute,safeError } from '../../../lib/operations';
export const dynamic='force-dynamic';
export async function POST(request:Request){try{const u=await getChatGPTUser();if(!u)throw new AppError(401,'sign_in_required','Sign in to access your tasks');const origin=request.headers.get('origin');if(origin&&origin!==new URL(request.url).origin)throw new AppError(403,'origin_mismatch','Request origin is not allowed');const body=await request.text();if(body.length>1500000)throw new AppError(413,'too_large','Import is too large');let v;try{v=JSON.parse(body)}catch{throw new AppError(400,'invalid_json','Request is not valid JSON')};if(!v||typeof v.name!=='string'||!v.args||typeof v.args!=='object')throw new AppError(400,'invalid_request','Invalid task request');return Response.json(await execute(new BoardService(database(),u.userId),v.name,v.args),{headers:{'Cache-Control':'no-store'}})}catch(e){const x=safeError(e);return Response.json(x.body,{status:x.status,headers:{'Cache-Control':'no-store'}})}}
