import { requireChatGPTUser } from './chatgpt-auth';
import Board from './board';
export const dynamic='force-dynamic';
export default async function Home(){await requireChatGPTUser('/');return <Board/>}
