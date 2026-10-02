import {JSDOM} from 'jsdom';
import assert from 'node:assert/strict';
const dom=new JSDOM('<!doctype html><html><body><button id="card">Open task</button></body></html>',{url:'http://localhost'});
for(const k of ['window','document','navigator','HTMLElement','HTMLInputElement','HTMLFormElement','HTMLSelectElement','HTMLTextAreaElement','Element','Node','NodeFilter','MutationObserver','Event','CustomEvent','KeyboardEvent','MouseEvent','DocumentFragment','getComputedStyle'])Object.defineProperty(globalThis,k,{value:(dom.window as any)[k],configurable:true});
(globalThis as any).requestAnimationFrame=(f:any)=>setTimeout(f,0);(globalThis as any).cancelAnimationFrame=clearTimeout;(globalThis as any).ResizeObserver=class{observe(){}unobserve(){}disconnect(){}};HTMLElement.prototype.scrollIntoView=function(){};HTMLElement.prototype.hasPointerCapture=()=>false;HTMLElement.prototype.setPointerCapture=()=>{};HTMLElement.prototype.releasePointerCapture=()=>{};window.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){},addListener(){},removeListener(){}} as any);window.confirm=()=>true;
const React=await import('react');(globalThis as any).React=React;const {render,screen,fireEvent,waitFor,cleanup,act}=await import('@testing-library/react');const {TaskDetails,SafeText}=await import('../app/task-details');const {validateTask}=await import('../lib/model');
const a={...validateTask({title:'Task A',nextAction:'Read https://example.com/a and <script>bad</script>',evidenceNote:'Unsafe https://user:secret@example.com',resources:[{kind:'product',label:'Sample product',url:'https://example.com/product',address:''},{kind:'location',label:'Sample location',address:'Fictional place',url:''}]}),id:crypto.randomUUID(),revision:1,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),archived:false};const b={...a,id:crypto.randomUUID(),title:'Task B',nextAction:'Second task details'};
const c={...a,id:crypto.randomUUID(),title:'Newly created task'};let failRefresh=false;
let resolverA:any,resolverB:any,hold=true,comments:any[]=[],posted:any[]=[],failSave=false,pendingSave:any=null;
(globalThis as any).fetch=async(_url:string,options:any)=>{if(options.signal?.aborted)throw new DOMException('signal is aborted without reason','AbortError');const {name,args}=JSON.parse(options.body);if(name==='create_task')return Response.json({task:{...c,...args.task}});if(name==='get_task'){if(hold)return new Promise(resolve=>{const fn=()=>resolve(Response.json({task:args.id===a.id?a:args.id===c.id?c:b,history:[]}));if(args.id===a.id)resolverA=fn;else resolverB=fn});return Response.json({task:args.id===a.id?a:args.id===c.id?c:b,history:[]})}if(name==='list_comments'){if(failRefresh){failRefresh=false;throw new Error('Simulated refresh transport error')}return Response.json({comments:comments.filter(x=>x.taskId===args.taskId),attachments:[],nextCursor:null})};if(name==='add_comment'){posted.push(args);comments=[{id:crypto.randomUUID(),taskId:args.taskId,body:args.body,attachmentIds:[],revision:1,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),archived:false},...comments];return Response.json({comment:comments[0]})}if(name==='update_task'){if(pendingSave)return new Promise(resolve=>{pendingSave.resolve=()=>resolve(Response.json({task:{...a,...args.patch,revision:2}}))});if(failSave)return Response.json({message:'Revision conflict test'},{status:409});return Response.json({task:{...a,...args.patch,revision:2}})}throw new Error('Unexpected action '+name)};
const focus={current:document.getElementById('card')},ref=React.createRef<any>();let closed=0;const props={open:true,taskId:a.id,onClose:()=>{closed++},onChanged:async()=>{},returnFocus:focus,ref};const view=render(<TaskDetails {...props}/>);
await waitFor(()=>assert.ok(resolverA));view.rerender(<TaskDetails {...props} taskId={b.id}/>);await waitFor(()=>assert.ok(resolverB));await act(async()=>resolverB());await screen.findByText('Task B');await act(async()=>resolverA());assert.ok(screen.getByText('Task B'));assert.equal(screen.queryByText('Task A'),null);console.log('PASS A-to-B stale-response isolation');
view.rerender(<TaskDetails {...props} taskId={a.id}/>);await waitFor(()=>assert.ok(screen.getByText('Loading task…')));view.rerender(<TaskDetails {...props} open={false}/>);await act(async()=>resolverA());assert.equal(screen.queryByRole('dialog'),null);console.log('PASS close-before-load remains closed');
hold=false;view.rerender(<TaskDetails {...props}/>);await screen.findByText('Task A');const safe=screen.getByRole('link',{name:'https://example.com/a'});assert.equal(safe.getAttribute('rel'),'noopener noreferrer');assert.equal(document.querySelector('script'),null);assert.equal(document.querySelector('a[href*="secret"]'),null);assert.ok(screen.getByRole('link',{name:/View product/}));assert.ok(screen.getByRole('link',{name:/View on map/}));console.log('PASS safe clickable prose, product and map links; no HTML execution or credential links');
fireEvent.click(screen.getByRole('button',{name:'Edit task'}));const title=screen.getByLabelText('Title') as HTMLTextAreaElement;fireEvent.change(title,{target:{value:'Unsaved title'}});assert.ok(screen.getByText('Unsaved changes'));window.confirm=()=>false;fireEvent.click(screen.getByRole('button',{name:'Close'}));assert.equal(closed,0);failSave=true;fireEvent.click(screen.getByRole('button',{name:'Save changes'}));await screen.findByText('Revision conflict test');assert.equal((screen.getByLabelText('Title') as HTMLTextAreaElement).value,'Unsaved title');assert.ok(screen.getByRole('button',{name:'Load current revision, keep my draft'}));console.log('PASS dirty-close guard and failed-save draft preservation');
window.confirm=()=>true;failSave=false;fireEvent.click(screen.getByRole('button',{name:'Cancel editing'}));let composer=screen.getByLabelText('Add a comment');for(let i=0;i<2;i++){fireEvent.change(composer,{target:{value:'Same intentional comment'}});fireEvent.click(screen.getByRole('button',{name:'Post comment'}));await waitFor(()=>assert.equal((composer as HTMLTextAreaElement).value,''));}assert.equal(posted.length,2);assert.notEqual(posted[0].requestKey,posted[1].requestKey);console.log('PASS intentional identical comments get fresh request keys');
view.rerender(<TaskDetails {...props} open={false}/>);view.rerender(<TaskDetails {...props} taskId={null}/>);await screen.findByLabelText('Title');fireEvent.change(screen.getByLabelText('Title'),{target:{value:c.title}});fireEvent.click(screen.getByRole('button',{name:'Save changes'}));await screen.findByRole('button',{name:'Post comment'});composer=screen.getByLabelText('Add a comment');fireEvent.change(composer,{target:{value:'First comment after creating a task'}});fireEvent.click(screen.getByRole('button',{name:'Post comment'}));await waitFor(()=>assert.equal((composer as HTMLTextAreaElement).value,''));await waitFor(()=>assert.ok(screen.queryByText('First comment after creating a task'),'Saved first comment must be immediately visible after a prior detail view was closed'));assert.equal(screen.queryByText('signal is aborted without reason'),null);console.log('PASS reopened new-task flow resets cancelled reads and reconciles first saved comment');
failRefresh=true;fireEvent.change(composer,{target:{value:'Saved despite refresh failure'}});const postCount=posted.length;fireEvent.click(screen.getByRole('button',{name:'Post comment'}));await screen.findByText('Saved despite refresh failure');await screen.findByText('Comment saved. The latest conversation could not refresh.');assert.equal(posted.length,postCount+1);assert.equal((composer as HTMLTextAreaElement).value,'');fireEvent.click(screen.getByRole('button',{name:'Refresh comments'}));await waitFor(()=>assert.ok(!screen.queryByText('Comment saved. The latest conversation could not refresh.')));assert.equal(posted.length,postCount+1);console.log('PASS saved mutation plus failed refresh is reconciled without false failure or duplicate posts');
cleanup();

// Exercise real detail interactions against revision-checked, replayable saves.
const itemA={id:crypto.randomUUID(),text:'Milk',checked:false},itemB={id:crypto.randomUUID(),text:'Watch Arrival',checked:true};
const checklistTask={...a,title:'Shopping and movies',checklist:[itemA,itemB]};
let savedTask:any=structuredClone(checklistTask),writeMode:'normal'|'hold'|'lose-response'='normal',releaseWrite:(()=>void)|null=null;
const checklistWrites:any[]=[],checklistCreates:any[]=[],replies=new Map<string,{args:any,task:any}>();
(globalThis as any).fetch=async(_url:string,options:any)=>{
 const {name,args}=JSON.parse(options.body);
 if(name==='get_task')return Response.json({task:structuredClone(savedTask),history:[]});
 if(name==='list_comments')return Response.json({comments:[],attachments:[],nextCursor:null});
 if(name==='create_task'){checklistCreates.push(args);savedTask={...a,...args.task,id:crypto.randomUUID(),revision:1};return Response.json({task:savedTask})}
 if(name==='update_task'){
  checklistWrites.push(structuredClone(args));
  const replay=replies.get(args.requestKey);if(replay){assert.deepEqual(args,replay.args);return Response.json({task:replay.task})}
  if(args.expectedRevision!==savedTask.revision)return Response.json({error:'revision_conflict',message:'Checklist changed elsewhere. Reload before saving.'},{status:409});
  const apply=()=>{savedTask={...savedTask,...args.patch,revision:savedTask.revision+1};replies.set(args.requestKey,{args:structuredClone(args),task:structuredClone(savedTask)});return Response.json({task:savedTask})};
  if(writeMode==='hold')return new Promise(resolve=>{releaseWrite=()=>resolve(apply())});
  const response=apply();if(writeMode==='lose-response'){writeMode='normal';throw new Error('Response was lost after saving')};return response;
 }
 throw new Error('Unexpected checklist action '+name);
};
function resetChecklist(task:any=checklistTask){cleanup();savedTask=structuredClone(task);checklistWrites.length=0;checklistCreates.length=0;replies.clear();writeMode='normal';releaseWrite=null;window.confirm=()=>true}
function openChecklist(extra:any={}){return render(<TaskDetails {...props} ref={ref} onChanged={async()=>{}} {...extra}/>)}

resetChecklist();let checklistView=openChecklist();await screen.findByRole('checkbox',{name:'Milk'});
assert.equal((screen.getByRole('checkbox',{name:'Watch Arrival'}) as HTMLInputElement).checked,true);
assert.equal(screen.getByText('Watch Arrival').tagName,'S','Checked saved item text is crossed out');
fireEvent.click(screen.getByRole('button',{name:'Edit task'}));
const keptId=savedTask.checklist[1].id;fireEvent.click(screen.getByRole('button',{name:'Remove checklist item 1'}));
fireEvent.change(screen.getByLabelText('Checklist item 1'),{target:{value:'Watch Dune'}});
fireEvent.click(screen.getByRole('button',{name:'Add item'}));const addedInput=screen.getByLabelText('Checklist item 2');
await waitFor(()=>assert.equal(document.activeElement,addedInput));fireEvent.change(addedInput,{target:{value:'Bread'}});
fireEvent.click(screen.getByRole('checkbox',{name:'Checklist item 2 checked'}));
fireEvent.click(screen.getByRole('button',{name:'Save changes'}));await screen.findByRole('checkbox',{name:'Bread'});
assert.deepEqual(savedTask.checklist[0],{id:keptId,text:'Watch Dune',checked:true});
assert.equal(savedTask.checklist[1].text,'Bread');assert.equal(savedTask.checklist[1].checked,true);assert.notEqual(savedTask.checklist[1].id,keptId);
assert.equal(screen.getByText('Bread').tagName,'S');assert.equal(screen.queryByText('Milk'),null);
console.log('PASS checklist add/edit/remove/checked editing keeps stable item IDs and crosses out saved checked text');

resetChecklist();checklistView=openChecklist();await screen.findByRole('checkbox',{name:'Milk'});writeMode='hold';
fireEvent.click(screen.getByRole('checkbox',{name:'Milk'}));await waitFor(()=>assert.ok(releaseWrite));
assert.equal((screen.getByRole('checkbox',{name:'Milk'}) as HTMLInputElement).disabled,true);
assert.equal((screen.getByRole('checkbox',{name:'Watch Arrival'}) as HTMLInputElement).disabled,true);
assert.equal((screen.getByRole('button',{name:'Edit task'}) as HTMLButtonElement).disabled,true);assert.equal(ref.current.canLeave(),false);
await act(async()=>releaseWrite!());await waitFor(()=>assert.equal((screen.getByRole('checkbox',{name:'Milk'}) as HTMLInputElement).checked,true));
assert.deepEqual(Object.keys(checklistWrites[0].patch),['checklist']);assert.equal(checklistWrites[0].expectedRevision,1);
assert.deepEqual(checklistWrites[0].patch.checklist,[{...itemA,checked:true},itemB]);assert.equal(screen.getByText('Milk').tagName,'S');
console.log('PASS saved checkbox uses a revision-checked checklist-only patch and blocks writes/navigation while saving');

resetChecklist();checklistView=openChecklist();await screen.findByRole('checkbox',{name:'Milk'});writeMode='lose-response';
fireEvent.click(screen.getByRole('checkbox',{name:'Milk'}));await screen.findByText('Response was lost after saving');
assert.equal(savedTask.checklist[0].checked,true);assert.equal((screen.getByRole('checkbox',{name:'Milk'}) as HTMLInputElement).checked,false);
assert.equal((screen.getByRole('checkbox',{name:'Milk'}) as HTMLInputElement).disabled,true);
fireEvent.click(screen.getByRole('button',{name:'Retry checklist change'}));await waitFor(()=>assert.equal((screen.getByRole('checkbox',{name:'Milk'}) as HTMLInputElement).checked,true));
assert.deepEqual(checklistWrites[0],checklistWrites[1]);assert.equal(savedTask.revision,2,'Lost-response replay must not perform a second mutation');
fireEvent.click(screen.getByRole('checkbox',{name:'Milk'}));await waitFor(()=>assert.equal((screen.getByRole('checkbox',{name:'Milk'}) as HTMLInputElement).checked,false));
assert.notEqual(checklistWrites[2].requestKey,checklistWrites[1].requestKey);assert.equal(checklistWrites[2].expectedRevision,2);
assert.equal(screen.getByText('Milk').tagName,'SPAN');console.log('PASS uncertain checkbox save retries identical arguments/key; later intentional toggle gets a fresh key');

resetChecklist();checklistView=openChecklist();await screen.findByRole('checkbox',{name:'Milk'});
const otherItem={id:crypto.randomUUID(),text:'Coffee from another agent',checked:false};savedTask={...savedTask,revision:2,checklist:[{...itemA,text:'Milk updated elsewhere'},itemB,otherItem]};
fireEvent.click(screen.getByRole('checkbox',{name:'Milk'}));await screen.findByText('Checklist changed elsewhere. Reload before saving.');
assert.equal(screen.queryByRole('button',{name:'Retry checklist change'}),null);assert.equal(savedTask.checklist[0].checked,false);assert.equal(checklistWrites.length,1);
fireEvent.click(screen.getByRole('button',{name:'Load current checklist'}));await screen.findByRole('checkbox',{name:'Coffee from another agent'});
assert.equal(checklistWrites.length,1,'Reload must not silently resubmit an old checklist');
fireEvent.click(screen.getByRole('checkbox',{name:'Milk updated elsewhere'}));await waitFor(()=>assert.equal(savedTask.checklist[0].checked,true));
assert.deepEqual(savedTask.checklist[2],otherItem);assert.equal(checklistWrites[1].expectedRevision,2);assert.notEqual(checklistWrites[0].requestKey,checklistWrites[1].requestKey);
console.log('PASS checklist conflict reload preserves another agent\'s items and requires an explicit new toggle');

resetChecklist();checklistView=openChecklist();await screen.findByRole('checkbox',{name:'Milk'});
fireEvent.click(screen.getByRole('button',{name:'Edit task'}));fireEvent.change(screen.getByLabelText('Checklist item 1'),{target:{value:'My unsaved milk draft'}});
savedTask={...savedTask,revision:2,checklist:[{...itemA,text:'Other saved milk'},itemB]};
fireEvent.click(screen.getByRole('button',{name:'Save changes'}));await screen.findByText('Checklist changed elsewhere. Reload before saving.');
fireEvent.click(screen.getByRole('button',{name:'Load current revision, keep my draft'}));await screen.findByText('Saved revision reloaded. Your draft remains below; review it and save again.');
assert.equal((screen.getByLabelText('Checklist item 1') as HTMLInputElement).value,'My unsaved milk draft');assert.equal(checklistWrites.length,1);
console.log('PASS editing conflict and explicit revision reload retain the unsaved checklist draft without automatic writes');

resetChecklist();checklistView=openChecklist({canWrite:false});await screen.findByRole('checkbox',{name:'Milk'});
assert.equal((screen.getByRole('checkbox',{name:'Milk'}) as HTMLInputElement).disabled,true);fireEvent.click(screen.getByRole('checkbox',{name:'Milk'}));assert.equal(checklistWrites.length,0);
assert.equal(screen.queryByRole('button',{name:'Edit task'}),null);
resetChecklist({...checklistTask,archived:true});checklistView=openChecklist();await screen.findByRole('checkbox',{name:'Milk'});
assert.equal((screen.getByRole('checkbox',{name:'Milk'}) as HTMLInputElement).disabled,true);assert.equal((screen.getByRole('button',{name:'Edit task'}) as HTMLButtonElement).disabled,true);
fireEvent.click(screen.getByRole('checkbox',{name:'Milk'}));assert.equal(checklistWrites.length,0);
resetChecklist();checklistView=openChecklist();await screen.findByRole('checkbox',{name:'Milk'});
fireEvent.change(screen.getByLabelText('Add a comment'),{target:{value:'Unsent comment'}});assert.equal((screen.getByRole('checkbox',{name:'Milk'}) as HTMLInputElement).disabled,true);
console.log('PASS read-only, archived and unsaved-comment guards prevent checklist autosaves');

const legacyTask:any={...a};delete legacyTask.checklist;resetChecklist(legacyTask);checklistView=openChecklist();await screen.findByText('No items yet.');
fireEvent.click(screen.getByRole('button',{name:'Add item'}));await screen.findByLabelText('Checklist item 1');assert.equal(screen.queryByText('Unsaved changes')!==null,true);
resetChecklist();checklistView=openChecklist({taskId:null});await screen.findByText('Add an item to start your list.');
fireEvent.change(screen.getByLabelText('Title'),{target:{value:'Weekend movies'}});fireEvent.click(screen.getByRole('button',{name:'Add item'}));
fireEvent.change(screen.getByLabelText('Checklist item 1'),{target:{value:'Watch a documentary'}});fireEvent.click(screen.getByRole('button',{name:'Save changes'}));await screen.findByRole('checkbox',{name:'Watch a documentary'});
assert.equal(checklistCreates.length,1);assert.equal(checklistCreates[0].task.checklist[0].checked,false);assert.match(checklistCreates[0].task.checklist[0].id,/^[0-9a-f-]{36}$/);
console.log('PASS legacy tasks display an empty checklist and new tasks can start a generic list');

resetChecklist();checklistView=openChecklist({onChanged:async()=>{throw new Error('Board refresh unavailable')}});await screen.findByRole('checkbox',{name:'Milk'});
fireEvent.click(screen.getByRole('checkbox',{name:'Milk'}));await screen.findByText('Checklist saved. The latest view could not refresh.');
assert.equal((screen.getByRole('checkbox',{name:'Milk'}) as HTMLInputElement).checked,true);assert.equal(screen.queryByRole('button',{name:'Retry checklist change'}),null);assert.equal(checklistWrites.length,1);
console.log('PASS saved checklist remains reconciled if the subsequent board refresh fails');
cleanup();
