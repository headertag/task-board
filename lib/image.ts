import { AppError } from './errors';
export const IMAGE_LIMIT=2*1024*1024, PIXEL_LIMIT=4_000_000;
const signature=[137,80,78,71,13,10,26,10];
function fail():never{throw new AppError(400,'invalid_image','Choose a valid PNG, JPEG or WebP image. Images are normalized to PNG, up to 2 MB and 4 million pixels.')}
export function crc32(data:Uint8Array){let c=0xffffffff;for(const n of data){c^=n;for(let k=0;k<8;k++)c=(c>>>1)^((c&1)?0xedb88320:0)}return (c^0xffffffff)>>>0}
function chunk(type:string,data:Uint8Array){const out=new Uint8Array(data.length+12),v=new DataView(out.buffer);v.setUint32(0,data.length);out.set(new TextEncoder().encode(type),4);out.set(data,8);v.setUint32(out.length-4,crc32(out.subarray(4,out.length-4)));return out}
export async function boundedBytes(stream:ReadableStream<Uint8Array>,limit:number){const reader=stream.getReader();let size=0;const chunks:Uint8Array[]=[];try{while(true){const r=await reader.read();if(r.done)break;size+=r.value.length;if(size>limit){await reader.cancel();throw new AppError(413,'too_large','File exceeds the allowed size')};chunks.push(r.value)}}finally{reader.releaseLock()}const out=new Uint8Array(size);let p=0;for(const c of chunks){out.set(c,p);p+=c.length}return out}
/** Narrow, bounded PNG normalization. Only 8-bit RGB/RGBA, non-interlaced PNGs are accepted. */
export async function normalizePng(bytes:Uint8Array){
 if(bytes.length>IMAGE_LIMIT)throw new AppError(413,'too_large','Normalized images must be under 2 MB');
 if(bytes.length<45||signature.some((v,i)=>bytes[i]!==v))fail();
 let pos=8,width=0,height=0,channels=0,header:Uint8Array|null=null,ended=false,seenData=false,dataEnded=false;const data:Uint8Array[]=[];
 while(pos<bytes.length){if(pos+12>bytes.length)fail();const view=new DataView(bytes.buffer,bytes.byteOffset+pos);const length=view.getUint32(0);if(length>IMAGE_LIMIT||pos+12+length>bytes.length)fail();const type=new TextDecoder().decode(bytes.subarray(pos+4,pos+8));const body=bytes.subarray(pos+8,pos+8+length);if(!/^[A-Za-z]{4}$/.test(type)||type[2]!==type[2].toUpperCase())fail();if(crc32(bytes.subarray(pos+4,pos+8+length))!==view.getUint32(8+length))fail();
 if(!header&&type!=='IHDR')fail();
 if(type==='IHDR'){if(header||length!==13)fail();width=view.getUint32(8);height=view.getUint32(12);if(!width||!height||width>4000||height>4000||width*height>PIXEL_LIMIT||body[8]!==8||![2,6].includes(body[9])||body[10]!==0||body[11]!==0||body[12]!==0)fail();channels=body[9]===6?4:3;header=body.slice()}
 else if(type==='IDAT'){if(dataEnded)fail();seenData=true;data.push(body)}
 else if(type==='IEND'){if(!seenData||length!==0||pos+12!==bytes.length)fail();ended=true;break}
 else{if(seenData)dataEnded=true;if(['acTL','fcTL','fdAT'].includes(type)||type[0]===type[0].toUpperCase())fail()}
 pos+=12+length;
 }
 if(!ended||!header||!data.length)fail();
 const compressed=new Uint8Array(data.reduce((n,d)=>n+d.length,0));let offset=0;for(const d of data){compressed.set(d,offset);offset+=d.length}
 const expected=(width*channels+1)*height;let raw:Uint8Array;
 offset=0;try{raw=await boundedBytes(new ReadableStream<Uint8Array>({pull(controller){if(offset>=compressed.length){controller.close();return}controller.enqueue(compressed.slice(offset,offset+1024));offset+=1024}}).pipeThrough(new DecompressionStream('deflate') as any),expected)}catch{fail()}
 if(raw.length!==expected)fail();for(let y=0;y<height;y++)if(raw[y*(width*channels+1)]>4)fail();
 const encoded=await boundedBytes(new Blob([raw as BlobPart]).stream().pipeThrough(new CompressionStream('deflate')),IMAGE_LIMIT);
 const parts=[new Uint8Array(signature),chunk('IHDR',header),chunk('IDAT',encoded),chunk('IEND',new Uint8Array())];const out=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));offset=0;for(const p of parts){out.set(p,offset);offset+=p.length}if(out.length>IMAGE_LIMIT)throw new AppError(413,'too_large','Normalized image exceeds 2 MB');
 return {bytes:out,width,height};
}
