import {JSDOM} from 'jsdom';
import assert from 'node:assert/strict';
const dom=new JSDOM('<!doctype html><html><body><button id="return">Return focus</button></body></html>',{url:'http://localhost'});
for(const key of ['window','document','navigator','HTMLElement','HTMLInputElement','HTMLFormElement','HTMLSelectElement','HTMLTextAreaElement','Element','Node','NodeFilter','MutationObserver','Event','CustomEvent','KeyboardEvent','MouseEvent','DocumentFragment','getComputedStyle'])Object.defineProperty(globalThis,key,{value:(dom.window as any)[key],configurable:true});
(globalThis as any).requestAnimationFrame=(fn:any)=>setTimeout(fn,0);(globalThis as any).cancelAnimationFrame=clearTimeout;(globalThis as any).ResizeObserver=class{observe(){}unobserve(){}disconnect(){}};
HTMLElement.prototype.scrollIntoView=function(){};HTMLElement.prototype.hasPointerCapture=()=>false;HTMLElement.prototype.setPointerCapture=()=>{};HTMLElement.prototype.releasePointerCapture=()=>{};
window.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){},addListener(){},removeListener(){}} as any);window.confirm=()=>true;
const React=await import('react');(globalThis as any).React=React;
const {render,screen,fireEvent,waitFor,cleanup,act,within}=await import('@testing-library/react');
const {AccessDialog}=await import('../app/access-dialog');const {default:Board}=await import('../app/board');const {validateTask}=await import('../lib/model');

const initialMembers=[{email:'owner@example.com',access:'write',active:true,bound:true,bootstrap:true},{email:'pending@example.com',access:'read',active:true,bound:false},{email:'verified@example.com',access:'write',active:true,bound:true}];
const task={...validateTask({title:'Guarded task'}),id:crypto.randomUUID(),revision:1,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),archived:false};
let members:any[]=[],calls:{url:string,method:string,body?:any}[]=[],getFailure=false,postFailure=false,loseReply=false,holdGet=false,holdPost=false,resolveGet:(()=>void)|null=null,resolvePost:(()=>void)|null=null,closed=0;
const returnFocus={current:document.getElementById('return')},props={open:true,canManageAccess:true,canWrite:true,onClose:()=>{closed++},returnFocus};
function reset(){cleanup();members=structuredClone(initialMembers);calls=[];getFailure=false;postFailure=false;loseReply=false;holdGet=false;holdPost=false;resolveGet=null;resolvePost=null;closed=0;window.confirm=()=>true}
(globalThis as any).fetch=async(url:string,options:any={})=>{
 const method=options.method??'GET',body=options.body?JSON.parse(options.body):undefined;calls.push({url,method,...(body?{body}:{})});
 if(url==='/api/board'){
  if(body.name==='list_tasks')return Response.json({tasks:body.args.archived?[]:[task]});
  if(body.name==='seed_samples')return Response.json({tasks:[task]});
  if(body.name==='get_task')return Response.json({task,history:[]});
  if(body.name==='list_comments')return Response.json({comments:[],attachments:[],nextCursor:null});
  throw new Error('Unexpected task operation '+body.name);
 }
 assert.equal(url,'/api/access','Access UI must not send invitations or call another service');assert.equal(options.credentials,'same-origin');
 if(method==='GET'){
  if(getFailure)return Response.json({message:'Access management is unavailable.'},{status:403});
  if(holdGet)return new Promise(resolve=>{resolveGet=()=>resolve(Response.json({members:structuredClone(members)}))});
  return Response.json({members:structuredClone(members)});
 }
 assert.equal(method,'POST');assert.deepEqual(options.headers,{'Content-Type':'application/json'});
 if(postFailure)return Response.json({message:'Could not update this address.'},{status:503});
 const apply=()=>{
  const existing=members.find(member=>member.email===body.email);
  assert.ok(!existing?.bootstrap,'UI must not modify bootstrap owner access');
  if(body.action==='allow'){if(existing){existing.active=true;existing.access=body.access}else members.push({email:body.email,access:body.access,active:true,bound:false})}
  else if(body.action==='revoke'){assert.ok(existing);existing.active=false}
  else throw new Error('Unexpected access action');
  return Response.json({members:structuredClone(members)});
 };
 if(holdPost)return new Promise(resolve=>{resolvePost=()=>resolve(apply())});
 const response=apply();if(loseReply){loseReply=false;throw new Error('Connection lost after saving. Reload addresses before trying again.')}return response;
};
const accessCalls=()=>calls.filter(call=>call.url==='/api/access'),writes=()=>accessCalls().filter(call=>call.method==='POST');

reset();let view=render(<Board canWrite={false}/>);await waitFor(()=>assert.ok(screen.queryByText('Loading saved tasks…')===null));
assert.equal(screen.queryByRole('button',{name:'Access'}),null);assert.equal(accessCalls().length,0);assert.ok(screen.getByText('Private board',{exact:false}));
cleanup();render(<AccessDialog {...props} canManageAccess={false}/>);assert.equal(screen.queryByRole('dialog'),null);assert.equal(accessCalls().length,0);
cleanup();render(<AccessDialog {...props} canManageAccess={'true' as any}/>);assert.equal(screen.queryByRole('dialog'),null);assert.equal(accessCalls().length,0);
console.log('PASS Access is hidden by default and for non-admin or untrusted truthy flags, without administrative reads');

reset();holdGet=true;view=render(<AccessDialog {...props}/>);await screen.findByText('Loading allowed addresses…');
assert.equal(screen.getByLabelText('Email address').matches(':disabled'),true);assert.equal(writes().length,0);
await act(async()=>resolveGet!());await screen.findByText('pending@example.com');
const ownerRow=screen.getByText('owner@example.com').closest('li')!;assert.equal(within(ownerRow).queryByRole('button'),null);
assert.equal(within(screen.getByText('pending@example.com').closest('li')!).getByText('Awaiting first Google sign-in').textContent,'Awaiting first Google sign-in');
assert.ok(within(screen.getByText('verified@example.com').closest('li')!).getByText('Google account verified'));
assert.equal((screen.getByLabelText('Permission') as unknown as HTMLSelectElement).value,'read');assert.equal(writes().length,0);
console.log('PASS owner is protected; pending and verified Google statuses reflect server data; loading never grants access');

fireEvent.change(screen.getByLabelText('Email address'),{target:{value:'FRIEND@example.com'}});fireEvent.change(screen.getByLabelText('Permission'),{target:{value:'write'}});assert.equal(writes().length,0);
holdPost=true;fireEvent.click(screen.getByRole('button',{name:'Add address'}));await waitFor(()=>assert.ok(resolvePost));
assert.deepEqual(writes()[0].body,{action:'allow',email:'friend@example.com',access:'write'});
assert.equal(screen.getByLabelText('Email address').matches(':disabled'),true);assert.equal((screen.getByRole('button',{name:'Revoke pending@example.com'}) as HTMLButtonElement).disabled,true);
fireEvent.submit(screen.getByLabelText('Email address').closest('form')!);assert.equal(writes().length,1,'A pending grant must not submit twice');
fireEvent.click(screen.getByRole('button',{name:'Close'}));assert.equal(closed,0,'Do not close while a mutation is pending');
await act(async()=>resolvePost!());await screen.findByText('Address allowed.');
const friendRow=screen.getByText('friend@example.com').closest('li')!;assert.ok(within(friendRow).getByText('Can view and edit'));assert.ok(within(friendRow).getByText('Awaiting first Google sign-in'));
assert.equal((screen.getByLabelText('Email address') as HTMLInputElement).value,'');assert.equal((screen.getByLabelText('Permission') as unknown as HTMLSelectElement).value,'read');assert.equal(accessCalls().filter(call=>call.method==='GET').length,1);
console.log('PASS explicit normalized grant, pending controls, double-submit guard and full-list response reconciliation without emails');

holdPost=false;fireEvent.click(screen.getByRole('button',{name:'Revoke verified@example.com'}));await screen.findByRole('button',{name:'Allow verified@example.com again'});
let verifiedRow=screen.getByText('verified@example.com').closest('li')!;assert.ok(within(verifiedRow).getByText('Revoked'));assert.ok(within(verifiedRow).getByText('Google account verified'));
fireEvent.click(screen.getByRole('button',{name:'Allow verified@example.com again'}));await screen.findByRole('button',{name:'Revoke verified@example.com'});
assert.deepEqual(writes().at(-1)!.body,{action:'allow',email:'verified@example.com',access:'write'});assert.equal(members.find(member=>member.email==='verified@example.com').bound,true);
verifiedRow=screen.getByText('verified@example.com').closest('li')!;const beforeEdit=writes().length;fireEvent.click(within(verifiedRow).getByRole('button',{name:'Change access'}));
assert.equal(writes().length,beforeEdit);assert.equal((screen.getByLabelText('Email address') as HTMLInputElement).value,'verified@example.com');
fireEvent.change(screen.getByLabelText('Permission'),{target:{value:'read'}});fireEvent.click(screen.getByRole('button',{name:'Save access'}));
await waitFor(()=>assert.equal(members.find(member=>member.email==='verified@example.com').access,'read'));assert.equal(members.find(member=>member.email==='verified@example.com').bound,true);
console.log('PASS revoke/reallow retains verification status; permission editing requires a separate explicit save');

reset();postFailure=true;view=render(<AccessDialog {...props}/>);await screen.findByText('pending@example.com');
fireEvent.change(screen.getByLabelText('Email address'),{target:{value:'failed@example.com'}});fireEvent.change(screen.getByLabelText('Permission'),{target:{value:'write'}});fireEvent.click(screen.getByRole('button',{name:'Add address'}));
await screen.findByText('Could not update this address.');assert.equal((screen.getByLabelText('Email address') as HTMLInputElement).value,'failed@example.com');assert.equal((screen.getByLabelText('Permission') as unknown as HTMLSelectElement).value,'write');
assert.equal(screen.queryByText('failed@example.com'),null);assert.equal(screen.queryByText('Address allowed.'),null);assert.equal(writes().length,1);assert.equal(accessCalls().filter(call=>call.method==='GET').length,1);
console.log('PASS mutation errors preserve the address draft and old membership list without automatic retries');

reset();loseReply=true;view=render(<AccessDialog {...props}/>);await screen.findByText('pending@example.com');
fireEvent.change(screen.getByLabelText('Email address'),{target:{value:'uncertain@example.com'}});fireEvent.click(screen.getByRole('button',{name:'Add address'}));await screen.findByText('Connection lost after saving. Reload addresses before trying again.');
assert.equal(screen.queryByText('uncertain@example.com'),null);fireEvent.click(screen.getByRole('button',{name:'Reload addresses'}));await screen.findByText('uncertain@example.com');assert.equal(writes().length,1);
console.log('PASS an uncertain saved grant is reconciled by a read-only reload, never an automatic second grant');

reset();getFailure=true;view=render(<AccessDialog {...props}/>);await screen.findByText('Access management is unavailable.');assert.equal(screen.getByLabelText('Email address').matches(':disabled'),true);
fireEvent.change(screen.getByLabelText('Email address'),{target:{value:'blocked@example.com'}});fireEvent.submit(screen.getByLabelText('Email address').closest('form')!);assert.equal(writes().length,0);
getFailure=false;fireEvent.click(screen.getByRole('button',{name:'Reload addresses'}));await screen.findByText('pending@example.com');assert.equal(writes().length,0);
console.log('PASS initial read denial fails closed until a successful manual reload');

reset();view=render(<Board canWrite={false} canManageAccess/>);await waitFor(()=>assert.ok(screen.queryByText('Loading saved tasks…')===null));assert.equal(accessCalls().length,0);
fireEvent.click(screen.getByRole('button',{name:'Access'}));await screen.findByText('pending@example.com');assert.ok(screen.getByText('This board is read-only. Access changes are unavailable.'));
assert.equal(screen.getByLabelText('Email address').matches(':disabled'),true);assert.equal((screen.getByRole('button',{name:'Revoke verified@example.com'}) as HTMLButtonElement).disabled,true);
fireEvent.change(screen.getByLabelText('Email address'),{target:{value:'frozen@example.com'}});fireEvent.submit(screen.getByLabelText('Email address').closest('form')!);assert.equal(writes().length,0);
console.log('PASS owner can inspect Access during global freeze, with every membership mutation disabled');

reset();holdGet=true;view=render(<AccessDialog {...props}/>);await waitFor(()=>assert.ok(resolveGet));const staleRead=resolveGet!;
view.rerender(<AccessDialog {...props} open={false}/>);holdGet=false;members=[{email:'fresh@example.com',access:'read',active:true,bound:false}];view.rerender(<AccessDialog {...props}/>);
await screen.findByText('fresh@example.com');members=structuredClone(initialMembers);await act(async()=>staleRead());assert.equal(screen.queryByText('pending@example.com'),null);assert.ok(screen.getByText('fresh@example.com'));assert.equal(writes().length,0);
console.log('PASS stale reads from a closed Access dialog cannot replace current membership data');

reset();view=render(<Board canManageAccess/>);await waitFor(()=>assert.ok(screen.queryByText('Loading saved tasks…')===null));
fireEvent.click(screen.getByRole('button',{name:/Guarded task/}));await screen.findByRole('button',{name:'Edit task'});fireEvent.click(screen.getByRole('button',{name:'Edit task'}));fireEvent.change(screen.getByLabelText('Title'),{target:{value:'Task draft still here'}});
window.confirm=()=>false;const accessButton=[...document.querySelectorAll('button')].find(button=>button.textContent==='Access')!;fireEvent.click(accessButton);
assert.equal(accessCalls().length,0);assert.equal((screen.getByLabelText('Title') as HTMLTextAreaElement).value,'Task draft still here');
window.confirm=()=>true;fireEvent.click(accessButton);await screen.findByText('pending@example.com');assert.equal(screen.queryByLabelText('Title'),null);assert.equal(writes().length,0);
fireEvent.click(screen.getByRole('button',{name:'Close'}));await waitFor(()=>assert.ok(screen.queryByRole('dialog')===null));const priorReads=calls.filter(call=>call.url==='/api/board'&&call.body?.name==='list_tasks').length;
fireEvent.click(screen.getByRole('button',{name:'Refresh tasks'}));await waitFor(()=>assert.equal(calls.filter(call=>call.url==='/api/board'&&call.body?.name==='list_tasks').length,priorReads+2));
console.log('PASS Access respects the existing task draft guard, opens only after deliberate discard, and preserves ordinary board refresh');
cleanup();
