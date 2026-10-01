import {toolDefinitions} from '../lib/operations.ts';
const json=JSON.stringify({tools:toolDefinitions});
console.log(JSON.stringify({tools:toolDefinitions.length,utf8Bytes:Buffer.byteLength(json),descriptionUtf8Bytes:toolDefinitions.reduce((n,t)=>n+Buffer.byteLength(t.description),0)},null,2));
