import {getChatGPTUser} from '../../chatgpt-auth';
import {database,imageStorage} from '../../../lib/db';
import {BoardService,AppError} from '../../../lib/service';
import {safeError} from '../../../lib/operations';
import {boundedBytes,IMAGE_LIMIT} from '../../../lib/image';
export const dynamic='force-dynamic';
const privateHeaders={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Cross-Origin-Resource-Policy':'same-origin','Referrer-Policy':'no-referrer'};
async function service(){const user=await getChatGPTUser();if(!user)throw new AppError(401,'sign_in_required','Sign in to access images');return new BoardService(database(),user.userId,imageStorage())}
export async function GET(request:Request){try{const s=await service();const id=new URL(request.url).searchParams.get('id')||'';const {metadata,object}=await s.activity.image(id);return new Response(object.body,{headers:{...privateHeaders,'Content-Type':'image/png','Content-Length':String(metadata.size),'Content-Disposition':'inline; filename="task-image.png"'}})}catch(e){const x=safeError(e);return Response.json(x.body,{status:x.status,headers:privateHeaders})}}
export async function POST(request:Request){try{const s=await service();if(request.headers.get('origin')!==new URL(request.url).origin)throw new AppError(403,'origin_mismatch','Upload origin is not allowed');if(request.headers.get('content-type')!=='image/png'||!request.body)throw new AppError(400,'invalid_image','Upload a normalized PNG image');const bytes=await boundedBytes(request.body,IMAGE_LIMIT);const filename=decodeURIComponent(request.headers.get('x-file-name')||'image.png');const attachment=await s.activity.upload(request.headers.get('x-task-id')||'',request.headers.get('x-upload-key')||'',bytes,filename);return Response.json({attachment},{headers:privateHeaders})}catch(e){const x=safeError(e);return Response.json(x.body,{status:x.status,headers:privateHeaders})}}
