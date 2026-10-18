import {getBoardPrincipal,authFailure} from '../../../authentication';
import {AuthError,requirePermission} from '../../../../lib/auth';
import {database,imageStorage} from '../../../../lib/db';
import {BoardService,AppError} from '../../../../lib/service';
import {execute} from '../../../../lib/operations';
import {attachmentZipStream,safeArchiveName} from '../../../../lib/attachment-zip';
export const dynamic='force-dynamic';
const privateHeaders={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Cross-Origin-Resource-Policy':'same-origin','Referrer-Policy':'no-referrer','Content-Security-Policy':"sandbox; default-src 'none'"};
async function authenticated(request:Request){
 const principal=await getBoardPrincipal(request);if(!principal)throw new AuthError(401,'sign_in_required','Sign in to download attachments');
 requirePermission(principal,'read');
 const origin=request.headers.get('origin');
 if(origin&&origin!==new URL(request.url).origin||principal.kind==='browser'&&request.headers.get('sec-fetch-site')==='cross-site')throw new AuthError(403,'origin_mismatch','Request origin is not allowed');
 return principal;
}
function failure(request:Request,error:unknown){const response=authFailure(request,error);for(const [key,value]of Object.entries(privateHeaders))response.headers.set(key,value);return response}
export async function GET(request:Request){
 try{
  const principal=await authenticated(request),service=new BoardService(database(),principal.ownerId,imageStorage());
  const taskId=new URL(request.url).searchParams.get('taskId')||'';
  // The same canonical list supplies the UI and MCP. Pending uploads are excluded.
  const result=await execute(service,'list_attachments',{taskId});
  if(!result.attachments.length)throw new AppError(404,'no_attachments','This task has no saved attachments');
  const task=await service.get(taskId);
  const body=attachmentZipStream(result.attachments,async id=>(await service.activity.image(id)).object.body,request.signal);
  return new Response(body,{headers:{...privateHeaders,'Content-Type':'application/zip','Content-Disposition':`attachment; filename="task-attachments.zip"; filename*=UTF-8''${encodeURIComponent(safeArchiveName(task.title)+'-attachments.zip')}`}});
 }catch(error){return failure(request,error)}
}
async function unsupported(request:Request){try{await authenticated(request);return new Response(null,{status:405,headers:{...privateHeaders,Allow:'GET'}})}catch(error){return failure(request,error)}}
export const POST=unsupported;export const PUT=unsupported;export const PATCH=unsupported;export const DELETE=unsupported;export const HEAD=unsupported;export const OPTIONS=unsupported;
