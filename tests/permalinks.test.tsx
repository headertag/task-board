import {JSDOM} from 'jsdom';
import assert from 'node:assert/strict';
const dom=new JSDOM('<!doctype html><html><body><button id="card">Open task</button></body></html>',{url:'http://localhost'});
for(const k of ['window','document','navigator','HTMLElement','HTMLInputElement','HTMLFormElement','HTMLSelectElement','HTMLTextAreaElement','Element','Node','NodeFilter','MutationObserver','Event','CustomEvent','KeyboardEvent','MouseEvent','DocumentFragment','getComputedStyle'])Object.defineProperty(globalThis,k,{value:(dom.window as any)[k],configurable:true});
(globalThis as any).requestAnimationFrame=(f:any)=>setTimeout(f,0);(globalThis as any).cancelAnimationFrame=clearTimeout;(globalThis as any).ResizeObserver=class{observe(){}unobserve(){}disconnect(){}};HTMLElement.prototype.scrollIntoView=function(){};HTMLElement.prototype.hasPointerCapture=()=>false;HTMLElement.prototype.setPointerCapture=()=>{};HTMLElement.prototype.releasePointerCapture=()=>{};window.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){},addListener(){},removeListener(){}} as any);window.confirm=()=>true;
const React=await import('react');(globalThis as any).React=React;
const {render,screen,fireEvent,waitFor,cleanup,act,within}=await import('@testing-library/react');
const {default:Board}=await import('../app/board');
const {validateTask}=await import('../lib/model');
const {taskPath,taskLinkSelection}=await import('../lib/task-links');
const webTools=new Map<string,any>();(document as any).modelContext={registerTool:(tool:any)=>{webTools.set(tool.name,tool)}};
const {safeReturnTo}=await import('../lib/browser-auth');
const a={...validateTask({title:'Fictional active task'}),id:crypto.randomUUID(),revision:1,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),archived:false};
const b={...a,id:crypto.randomUUID(),title:'Fictional reference task',status:'Reference'};
const trash={...a,id:crypto.randomUUID(),title:'Fictional archived task',archived:true};
let records=[a,b,trash],calls:any[]=[],holdRead:string|null=null,releaseRead:any=null,holdWrite=false,releaseWrite:any=null;
(globalThis as any).fetch=async(_url:string,options:any)=>{
 const {name,args}=JSON.parse(options.body);calls.push({name,args});
 if(name==='seed_samples')return Response.json({});
 if(name==='list_tasks')return Response.json({tasks:records.filter(t=>t.archived===!!args.archived)});
 if(name==='list_comments')return Response.json({comments:[],attachments:[],nextCursor:null});
 if(name==='list_attachments')return Response.json({attachments:[]});
 if(name==='get_task'){
  const task=records.find(t=>t.id===args.id);
  const result=()=>task?Response.json({task,history:[]}):Response.json({error:'not_found',message:'Task not found'},{status:404});
  if(holdRead===args.id)return new Promise(resolve=>{releaseRead=()=>resolve(result())});
  return result();
 }
 if(name==='create_task'){const task={...a,...args.task,id:crypto.randomUUID()};records.push(task);return Response.json({task})}
 if(name==='update_task'){const task={...records.find(t=>t.id===args.id),...args.patch,revision:2};if(holdWrite)return new Promise(resolve=>{releaseWrite=()=>resolve(Response.json({task}))});return Response.json({task})}
 throw new Error('Unexpected operation '+name);
};
async function mount(path='/',canWrite=true){cleanup();window.history.replaceState(null,'',path);render(<Board canWrite={canWrite}/>);await act(async()=>{await new Promise(resolve=>setTimeout(resolve,10))})}
async function go(delta:number){await act(async()=>{window.history.go(delta);await new Promise(resolve=>setTimeout(resolve,40))})}
const dialog=()=>screen.getByRole('dialog');
const heading=(title:string)=>within(dialog()).findByRole('heading',{name:title});
let copied='';Object.defineProperty(navigator,'clipboard',{value:{writeText:async(text:string)=>{copied=text}},configurable:true});

assert.equal(taskPath(a.id),'/?task='+a.id);
for(const search of ['?task=bad','?task=','?task='+a.id+'&task='+b.id])assert.equal(taskLinkSelection(search).invalid,true);
for(const value of ['https://foreign.example/','//foreign.example/','/\\foreign.example/','/auth/signin','/api/board','/?task=bad','/?task='+a.id+'&task='+b.id,'/?task='+a.id+'#fragment','/?secret=value','/	/foreign.example'])assert.equal(safeReturnTo(value),'/');
assert.equal(safeReturnTo(taskPath(a.id)),taskPath(a.id));
console.log('PASS strict task identity and same-origin sign-in destinations');

await mount('/');
const columnNav=screen.getByRole('navigation',{name:'Task columns'}),scroller=document.querySelector('.board') as HTMLElement;
scroller.scrollTo=({left}:any)=>{scroller.scrollLeft=left};
for(const [i,column] of Array.from(scroller.querySelectorAll<HTMLElement>('[data-status]')).entries())column.getBoundingClientRect=()=>({left:i*400-scroller.scrollLeft} as DOMRect);
scroller.getBoundingClientRect=()=>({left:0} as DOMRect);
const todo=within(columnNav).getByRole('button',{name:/To do/}),progress=within(columnNav).getByRole('button',{name:/In progress/}),hold=within(columnNav).getByRole('button',{name:/On hold/});
assert.equal(todo.getAttribute('aria-pressed'),'true');fireEvent.click(progress);assert.equal(scroller.scrollLeft,400);assert.equal(progress.getAttribute('aria-pressed'),'true');
scroller.scrollLeft=800;fireEvent.scroll(scroller);assert.equal(hold.getAttribute('aria-pressed'),'true');
fireEvent.mouseDown(screen.getByRole('tab',{name:/Closed/}),{button:0,ctrlKey:false});assert.equal(screen.getByRole('button',{name:/Completed/}).getAttribute('aria-pressed'),'true');
fireEvent.mouseDown(screen.getByRole('tab',{name:/Active/}),{button:0,ctrlKey:false});assert.equal(screen.getByRole('button',{name:/To do/}).getAttribute('aria-pressed'),'true');
console.log('PASS mobile column buttons, horizontal scroll selection and view reset');

await mount(taskPath(b.id),false);await heading(b.title);
assert.ok(calls.some(c=>c.name==='get_task'&&c.args.id===b.id));
assert.equal(screen.queryByRole('button',{name:'Edit task'}),null);
fireEvent.click(screen.getByRole('button',{name:'Copy task link'}));await waitFor(()=>assert.equal(copied,'http://localhost'+taskPath(b.id)));
fireEvent.click(screen.getByRole('button',{name:'Close'}));await waitFor(()=>assert.equal(screen.queryByRole('dialog'),null));
assert.equal(window.location.search,'');await waitFor(()=>assert.equal(document.activeElement,screen.getByRole('button',{name:'Refresh tasks'})));
await go(-1);await heading(b.title);await go(1);await waitFor(()=>assert.equal(screen.queryByRole('dialog'),null));
await mount(taskPath(b.id));await heading(b.title); // Reload / another document resolves outside Active.
console.log('PASS direct/reloaded out-of-filter links, read-only copying, close/back/forward and fallback focus');

await mount();const card=screen.getByRole('button',{name:new RegExp(a.title)});card.focus();fireEvent.click(card);await heading(a.title);
assert.equal(window.location.search,'?task='+a.id);
fireEvent.click(screen.getByRole('button',{name:'Edit task'}));fireEvent.change(screen.getByLabelText('Title'),{target:{value:'Unsaved navigation draft'}});
window.confirm=()=>false;const entries=window.history.length;await go(-1);
await waitFor(()=>assert.equal(window.location.search,'?task='+a.id));
assert.equal(window.history.length,entries);assert.equal((screen.getByLabelText('Title') as HTMLTextAreaElement).value,'Unsaved navigation draft');
window.confirm=()=>true;await go(-1);await waitFor(()=>assert.equal(screen.queryByRole('dialog'),null));
await waitFor(()=>assert.equal(document.activeElement,card));await go(1);await heading(a.title);
fireEvent.change(screen.getByLabelText('Add a comment'),{target:{value:'Unsent comment'}});window.confirm=()=>false;await go(-1);await waitFor(()=>assert.equal(window.location.search,'?task='+a.id));
assert.equal((screen.getByLabelText('Add a comment') as HTMLTextAreaElement).value,'Unsent comment');
window.confirm=()=>true;await go(-1);await waitFor(()=>assert.equal(screen.queryByRole('dialog'),null));
console.log('PASS Back cancellation keeps task/comment drafts, URL and history consistent; acceptance restores card focus');

await mount();fireEvent.click(screen.getByRole('button',{name:new RegExp(a.title)}));await heading(a.title);
fireEvent.click(screen.getByRole('button',{name:'Edit task'}));fireEvent.change(screen.getByLabelText('Title'),{target:{value:'Saving task'}});
holdWrite=true;fireEvent.click(screen.getByRole('button',{name:'Save changes'}));await waitFor(()=>assert.ok(releaseWrite));await go(-1);
await waitFor(()=>assert.equal(window.location.search,'?task='+a.id));assert.ok(screen.getByLabelText('Title'));
const unload=new dom.window.Event('beforeunload',{cancelable:true});window.dispatchEvent(unload);assert.equal(unload.defaultPrevented,true);
await act(async()=>releaseWrite());holdWrite=false;await heading('Saving task');
console.log('PASS in-flight mutation blocks history navigation and page unload');

await mount();fireEvent.click(screen.getByRole('button',{name:new RegExp(a.title)}));await heading(a.title);
const beforeDuplicate=window.history.length;
await act(async()=>{await webTools.get('open_task_details').execute({id:a.id})});assert.equal(window.history.length,beforeDuplicate);
await act(async()=>{await webTools.get('open_task_details').execute({id:b.id})});await heading(b.title);assert.equal(window.location.search,'?task='+b.id);
await go(-1);await heading(a.title);await go(1);await heading(b.title);
let releaseBytes:any;const uploadingFile={name:'fictional.txt',type:'text/plain',size:3,lastModified:1,arrayBuffer:()=>new Promise(resolve=>{releaseBytes=()=>resolve(new Uint8Array([1,2,3]).buffer)})};
fireEvent.change(screen.getByLabelText('Upload task files'),{target:{files:[uploadingFile]}});await waitFor(()=>assert.ok(releaseBytes));window.confirm=()=>false;await go(-1);await waitFor(()=>assert.equal(window.location.search,'?task='+b.id));assert.ok(screen.getAllByText('Uploading fictional.txt…').length);
window.confirm=()=>true;await go(-1);await heading(a.title);await act(async()=>releaseBytes());assert.equal(window.location.search,'?task='+a.id);
console.log('PASS task switching, duplicate navigation, Back/Forward and pending-upload cancellation');

holdRead=a.id;await mount(taskPath(a.id));await waitFor(()=>assert.ok(releaseRead));fireEvent.click(screen.getByRole('button',{name:'Close'}));
await act(async()=>releaseRead());await waitFor(()=>assert.equal(screen.queryByRole('dialog'),null));assert.equal(window.location.search,'');holdRead=null;
await mount(taskPath(trash.id));await heading(trash.title);assert.ok(screen.getByText(/This task is in recoverable Trash/));
assert.equal(calls.filter(c=>c.name==='restore_task').length,0);
await mount(taskPath(crypto.randomUUID()));await screen.findByText('Task unavailable. Sign in with an allowed account or return to the board.');assert.equal(screen.queryByRole('button',{name:'Copy task link'}),null);
await mount('/?task=bad');await screen.findByText('Invalid task link. Open a task from the board to copy a valid link.');assert.equal(screen.queryByRole('dialog'),null);
console.log('PASS late reads cannot reopen closed details; archived, missing and malformed links are safe');

await mount();fireEvent.click(screen.getByRole('button',{name:'New task'}));fireEvent.change(await screen.findByLabelText('Title'),{target:{value:'Fictional newly saved task'}});fireEvent.click(screen.getByRole('button',{name:'Save changes'}));await heading('Fictional newly saved task');
await waitFor(()=>assert.equal(window.location.search,'?task='+records.at(-1)!.id));
fireEvent.click(screen.getByRole('button',{name:'Copy task link'}));await waitFor(()=>assert.equal(copied,'http://localhost'+taskPath(records.at(-1)!.id)));
console.log('PASS newly created tasks acquire a copyable stable URL only after saving');
cleanup();
