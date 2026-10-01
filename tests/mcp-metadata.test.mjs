import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {toolDefinitions} from '../lib/operations.ts';
const tools=Object.fromEntries(toolDefinitions.map(t=>[t.name,t]));
assert.equal(toolDefinitions.length,20);assert.equal(Object.keys(tools).length,20);
assert.ok(Buffer.byteLength(JSON.stringify({tools:toolDefinitions}))<=11800,'Keep tools/list concise, including the versioned migration capture');
for(const t of toolDefinitions){assert.ok(t.description.length<=160,t.name);assert.doesNotMatch(t.description,/pilot/i);assert.equal(t.inputSchema.additionalProperties,false);}
for(const name of ['create_task','update_task','complete_task','archive_task','restore_task','add_comment','edit_comment','archive_comment','restore_comment','import_tasks']){const t=tools[name];assert.equal(t.annotations.idempotentHint,true);assert.ok(t.inputSchema.required.includes('requestKey'));assert.match(t.inputSchema.properties.requestKey.description,/identical retries/);}
for(const name of ['update_task','complete_task','archive_task','restore_task','edit_comment','archive_comment','restore_comment']){assert.ok(tools[name].inputSchema.required.includes('expectedRevision'));assert.equal(tools[name].inputSchema.properties.expectedRevision.minimum,1);}
assert.match(tools.update_task.description,/complete_task/);assert.match(tools.update_task.inputSchema.properties.patch.properties.sourceVerifiedAt.description,/Actual source check/);
assert.match(tools.export_backup_page.description,/ALL nextCursor pages/);assert.match(tools.export_backup_page.description,/checksum chain\/counts/);assert.match(tools.import_tasks.description,/owner approval/);assert.match(tools.import_tasks.description,/new requestKey duplicates/);
assert.equal(tools.export_migration_page.annotations.readOnlyHint,true);
assert.match(tools.export_migration_page.description,/frozen/i);
const descriptor=JSON.parse(readFileSync('server.example.json','utf8'));
assert.equal(descriptor.$schema,'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json');assert.equal(descriptor.title,'Yet Another Task Board');assert.equal(descriptor.version,'1.2.0');assert.equal(descriptor.remotes[0].type,'streamable-http');assert.equal(new URL(descriptor.remotes[0].url).hostname,'task-board.example.com');assert.equal(descriptor.remotes[0].headers,undefined);
const route=readFileSync('app/mcp/route.ts','utf8');assert.match(route,/protocolVersion: '2025-03-26'/);assert.match(route,/name: 'yet-another-task-board'/);assert.match(route,/version: '1.2.0'/);
assert.equal(readFileSync('app/board.tsx','utf8').includes('PILOT'),false);assert.match(readFileSync('app/layout.tsx','utf8'),/title: "Yet Another Task Board"/);
console.log('PASS lean discovery, stable tools/revisions/retry/privacy semantics, generic registry template and product branding');
