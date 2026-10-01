export function safeHttpUrl(value:string):string|null {
 if(!/^https?:\/\//i.test(value)||/[\u0000-\u0020\u007f]/.test(value)||value.length>2000)return null;
 try{const u=new URL(value);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password?u.href:null}catch{return null}
}
export function stable(value:unknown):string{return JSON.stringify(value,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.keys(x).sort().reduce((o:any,k)=>(o[k]=x[k],o),{}):x)}
export async function hash(value:string|Uint8Array){const bytes=typeof value==='string'?new TextEncoder().encode(value):value;return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes as BufferSource))].map(b=>b.toString(16).padStart(2,'0')).join('')}
export function base64(bytes:Uint8Array){let out='';for(let i=0;i<bytes.length;i+=8192)out+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(out)}
export function unbase64(s:string){return Uint8Array.from(atob(s),c=>c.charCodeAt(0))}
export async function stableId(value:string){const h=await hash(value);return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`}
