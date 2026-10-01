import {loopbackUrl} from './loopback.mjs';
import {syntheticCredentials,credentialHeaders,assertSyntheticProbe} from './synthetic-credentials.mjs';
import assert from 'node:assert/strict';import{readFileSync}from'node:fs';
const credentials=syntheticCredentials(),p=JSON.parse(readFileSync('.sites-runtime/persistence-probe.json','utf8'));assertSyntheticProbe(p,credentials);p.url=loopbackUrl(p.url);
const r=await fetch(p.url+'/api/board',{method:'POST',headers:credentialHeaders(credentials,'read'),body:JSON.stringify({name:'get_task',args:{id:p.id}})});assert.equal(r.status,200);const v=await r.json();assert.equal(v.task.id,p.id);assert.equal(v.task.status,'InProgress');assert.equal(v.task.revision,2);console.log('PASS: D1 task survives complete Worker process restart with same ID, status and revision using freshly supplied synthetic read credentials.');
