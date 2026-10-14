import { requireBoardPrincipal } from './authentication';
import {taskPath, validTaskId} from '../lib/task-links';
import Board from './board';
export const dynamic='force-dynamic';
export default async function Home({searchParams}: {searchParams: Promise<Record<string,string|string[]|undefined>>}) {
  const query=await searchParams;
  const returnTo=validTaskId(query.task)?taskPath(query.task):'/';
  const principal=await requireBoardPrincipal(returnTo);
  return <Board canWrite={principal.canWrite} canManageAccess={principal.canManageAccess??false}/>;
}
