import { requireBoardPrincipal } from './authentication';
import Board from './board';
export const dynamic='force-dynamic';
export default async function Home(){const principal=await requireBoardPrincipal('/');return <Board canWrite={principal.canWrite} canManageAccess={principal.canManageAccess??false}/>}
