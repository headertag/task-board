// Preview links are private reads; originals remain exact-byte downloads.
export function attachmentPreviewPath(attachment: {id:string;filename:string;contentType:string}): string|null {
  if (attachment.contentType!=='image/png' && !/\.(png|jpe?g|gif|webp)$/i.test(attachment.filename)) return null;
  return '/api/images?id='+encodeURIComponent(attachment.id)+'&preview=1';
}
// Never trust a filename/MIME claim when serving a generic file inline.
// Only raster formats can enter an <img>; SVG/HTML/PDF stay downloads.
export function rasterContentType(bytes: Uint8Array): string|null {
  const starts=(values:number[])=>values.every((n,i)=>bytes[i]===n);
  if(bytes.length>=24&&starts([137,80,78,71,13,10,26,10]))return 'image/png';
  if(bytes.length>=4&&starts([255,216,255]))return 'image/jpeg';
  const ascii=(from:number,to:number)=>String.fromCharCode(...bytes.subarray(from,to));
  if(bytes.length>=13&&['GIF87a','GIF89a'].includes(ascii(0,6)))return 'image/gif';
  if(bytes.length>=16&&ascii(0,4)==='RIFF'&&ascii(8,12)==='WEBP'&&['VP8 ','VP8L','VP8X'].includes(ascii(12,16)))return 'image/webp';
  return null;
}
