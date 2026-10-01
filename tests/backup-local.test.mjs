import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtemp, mkdir, writeFile, readFile, readdir, stat, chmod, symlink, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {deflateSync} from 'node:zlib';
import {backupLocal, BackupLocalError} from '../scripts/backup-local.mjs';
import {validateBackup} from '../lib/backup.ts';
import {taskInput} from '../lib/model.ts';
import {normalizePng, crc32} from '../lib/image.ts';
import {hash, stable, base64} from '../lib/safety.ts';
import {recoverBackup} from '../scripts/recover-backup.mjs';

// Every identity, token, record, and image is fictional and remains loopback-only.
const token = 'fictional-local-test-token';
const when = '2026-01-01T00:00:00.000Z';
const taskId = '11111111-1111-4111-8111-111111111111';
const commentId = '22222222-2222-4222-8222-222222222222';
const attachmentId = '33333333-3333-4333-8333-333333333333';
function chunk(type, body) {
  const out = new Uint8Array(body.length + 12), view = new DataView(out.buffer);
  view.setUint32(0, body.length); out.set(new TextEncoder().encode(type), 4); out.set(body, 8);
  view.setUint32(out.length - 4, crc32(out.subarray(4, out.length - 4))); return out;
}
const header = new Uint8Array(13); new DataView(header.buffer).setUint32(0, 1); new DataView(header.buffer).setUint32(4, 1); header[8] = 8; header[9] = 6;
const image = (await normalizePng(Buffer.concat([Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Uint8Array.from([0, 255, 0, 0, 255]))), chunk('IEND', new Uint8Array())]))).bytes;
const task = {...taskInput.parse({title: 'Fictional recovery rehearsal', sample: true}), id: taskId, revision: 1, createdAt: when, updatedAt: when, archived: false};
const archivedTask = {...task, revision: 2, archived: true};
const attachment = {id: attachmentId, taskId, filename: 'fictional.png', contentType: 'image/png', size: image.length, width: 1, height: 1, sha256: await hash(image), createdAt: when};
const retained = {...attachment, id: '44444444-4444-4444-8444-444444444444', filename: 'retained-draft.png'};
const comment = {id: commentId, taskId, body: 'Fictional image comment', attachmentIds: [attachmentId], revision: 1, createdAt: when, updatedAt: when, archived: false};
const removedComment = {...comment, revision: 2, archived: true};
const history = [
  {requestKey: 'synthetic-create-01', fingerprint: 'a'.repeat(64), taskId, action: 'create', before: null, after: task, createdAt: when},
  {requestKey: 'synthetic-archive-01', fingerprint: 'b'.repeat(64), taskId, action: 'archive', before: task, after: archivedTask, createdAt: when},
];
const commentHistory = [
  {requestKey: 'synthetic-comment-01', fingerprint: 'c'.repeat(64), commentId, taskId, action: 'add', before: null, after: comment, createdAt: when},
  {requestKey: 'synthetic-comment-02', fingerprint: 'd'.repeat(64), commentId, taskId, action: 'archive', before: comment, after: removedComment, createdAt: when},
];
const snapshot = {id: 'fictional-before-import', createdAt: when, data: {format: 'task-board-pilot', version: 2, exportedAt: when, tasks: [archivedTask], history: history.map(({requestKey, fingerprint, ...event}) => event), comments: [removedComment], commentHistory: commentHistory.map(({requestKey, fingerprint, ...event}) => event), attachments: [attachment, retained].map(a => ({...a, dataBase64: base64(image)}))}};
async function rechain(pages) {
  let previous = null;
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i]; p.sequence = i; p.previousChecksum = previous;
    const {checksum, nextCursor, ...body} = p;
    p.checksum = await hash(stable(body)); previous = p.checksum;
  }
  return pages;
}
async function fixture() {
  const common = {format: 'task-board-backup-page', version: 2, backupId: '55555555-5555-4555-8555-555555555555', capturedAt: when, tasks: [], history: [], snapshots: [], commentHistory: [], attachments: [], attachmentParts: [], complete: false};
  return rechain(structuredClone([
    {...structuredClone(common), pageKind: 'manifest', tasks: [archivedTask], attachments: [attachment, retained], counts: {tasks: 1, history: 2, snapshots: 1, comments: 1, commentHistory: 2, attachments: 2, attachmentParts: 2, attachmentBytes: image.length * 2}},
    {...structuredClone(common), pageKind: 'history', history: [history[0]]},
    {...structuredClone(common), pageKind: 'history', history: [history[1]]},
    {...structuredClone(common), pageKind: 'snapshots', snapshots: [snapshot]},
    {...structuredClone(common), pageKind: 'commentHistory', commentHistory},
    {...structuredClone(common), pageKind: 'images', attachmentParts: [{id: attachmentId, offset: 0, dataBase64: base64(image), sha256: await hash(image)}]},
    {...structuredClone(common), pageKind: 'images', attachmentParts: [{id: retained.id, offset: 0, dataBase64: base64(image), sha256: await hash(image)}], complete: true},
  ].map((p, i, a) => ({...p, nextCursor: i === a.length - 1 ? null : `fictional-cursor-${i + 1}`}))));
}
async function area(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'task-board-backup-test-'));
  await chmod(root, 0o700);
  const destination = path.join(root, 'snapshots'), tokenFile = path.join(root, 'credential');
  await mkdir(destination, {mode: 0o700}); await writeFile(tokenFile, token + '\n', {mode: 0o600});
  t.after(() => rm(root, {recursive: true, force: true}));
  return {root, destination, tokenFile};
}
async function server(t, handle) {
  const requests = [];
  const http = createServer(async (req, res) => {
    let body = ''; for await (const data of req) body += data;
    requests.push({url: req.url, headers: req.headers, body: JSON.parse(body || '{}')});
    await handle(requests.at(-1), res, requests.length);
  });
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  t.after(() => new Promise(resolve => { http.closeAllConnections(); http.close(resolve); }));
  return {origin: `http://127.0.0.1:${http.address().port}`, requests};
}
async function context(t, override) {
  const storage = await area(t), pages = await fixture();
  const remote = await server(t, override ?? ((req, res) => { const i = req.body.args.cursor ? Number(req.body.args.cursor.split('-').at(-1)) : 0; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(pages[i])); }));
  return {...storage, ...remote, pages, options: {...storage, origin: remote.origin, allowHttpLoopback: true}};
}
async function noSnapshot(destination) { assert.deepEqual(await readdir(destination), []); }
async function rejection(options, code) { await assert.rejects(() => backupLocal(options), e => e instanceof BackupLocalError && e.code === code); }

test('complete paginated v2 snapshot is private, exact, and recoverable with unchanged IDs and retained image bytes', async t => {
  const c = await context(t), out = await backupLocal({...c.options, pageSize: 1});
  assert.equal(out.complete, true); assert.equal(out.pageCount, c.pages.length);
  assert.equal((await stat(out.filename)).mode & 0o777, 0o600);
  assert.equal((await stat(c.destination)).mode & 0o777, 0o700);
  const downloaded = JSON.parse(await readFile(out.filename, 'utf8'));
  assert.deepEqual(downloaded.pages, c.pages);
  const verified = await validateBackup(downloaded.pages);
  assert.deepEqual(verified.tasks, [archivedTask]); assert.deepEqual(verified.comments, [removedComment]);
  assert.deepEqual(verified.blobs.get(attachmentId), image); assert.deepEqual(verified.blobs.get(retained.id), image);
  c.requests.forEach((r, i) => { assert.equal(r.url, '/api/board'); assert.equal(r.headers.authorization, `Bearer ${token}`); assert.deepEqual(r.body, {name: 'export_backup_page', args: {pageSize: 1, ...(i ? {cursor: c.pages[i - 1].nextCursor} : {})}}); assert.equal(r.headers.cookie, undefined); });
  const recovered = await recoverBackup(downloaded.pages, path.join(c.root, 'rehearsal'), 'fictional-immutable-owner');
  assert.equal(recovered.complete, true); assert.deepEqual(recovered.counts, c.pages[0].counts);
  assert.equal((await recoverBackup(downloaded.pages, path.join(c.root, 'rehearsal'), 'fictional-immutable-owner')).complete, true);
  assert.deepEqual(new Uint8Array(await readFile(path.join(recovered.objects, `${attachmentId}.png`))), image);
  assert.deepEqual(new Uint8Array(await readFile(path.join(recovered.objects, `${retained.id}.png`))), image);
  await rejection(c.options, 'destination'); // A capture never replaces this snapshot.
  assert.deepEqual(JSON.parse(await readFile(out.filename, 'utf8')).pages, c.pages);
});

for (const [name, change] of [
  ['page checksum mismatch', pages => { pages[1].history[0].after.title = 'Corrupted'; }],
  ['missing page', pages => { pages.splice(1, 1); }],
  ['mixed backup IDs', pages => { pages[2].backupId = '66666666-6666-4666-8666-666666666666'; }],
  ['wrong manifest count', async pages => { pages[0].counts.comments++; await rechain(pages); }],
  ['duplicate image part', async pages => { pages[5].attachmentParts.push({...pages[5].attachmentParts[0]}); pages[0].counts.attachmentParts++; await rechain(pages); }],
  ['corrupt image bytes', async pages => { pages[5].attachmentParts[0].dataBase64 = base64(new Uint8Array(image.length)); await rechain(pages); }],
  ['image dimensions disagree with verified PNG', async pages => { pages[0].attachments[0].width = 2; await rechain(pages); }],
  ['invalid task revision chain', async pages => { pages[2].history[0].before = null; await rechain(pages); }],
  ['repeated cursor', async pages => { pages[1].nextCursor = pages[0].nextCursor; await rechain(pages); }],
  ['incomplete final marker', async pages => { pages.at(-1).complete = false; await rechain(pages); }],
]) test(`rejects ${name} without publishing a partial capture`, async t => {
  const c = await context(t); await change(c.pages); await rejection(c.options, 'invalid_backup'); await noSnapshot(c.destination);
});

test('interrupted page request preserves existing snapshots and leaves no partial file', async t => {
  const pages = await fixture();
  const c = await context(t, (_req, res, i) => { if (i === 3) { res.destroy(); return; } res.end(JSON.stringify(pages[i - 1])); });
  const existing = path.join(c.destination, 'older.json'); await writeFile(existing, 'fictional older backup', {mode: 0o600});
  await rejection(c.options, 'request'); assert.deepEqual(await readdir(c.destination), ['older.json']); assert.equal(await readFile(existing, 'utf8'), 'fictional older backup');
});

test('redirects cannot forward a bearer token, including same-origin redirects', async t => {
  let forwarded = 0;
  const other = await server(t, (_req, res) => { forwarded++; res.end('{}'); });
  for (const crossOrigin of [true, false]) {
    const c = await context(t, (_req, res) => { res.writeHead(307, {Location: crossOrigin ? other.origin + '/steal' : '/other-route'}); res.end(); });
    await rejection(c.options, 'request'); assert.equal(c.requests.length, 1); await noSnapshot(c.destination);
  }
  assert.equal(forwarded, 0);
});

test('overlap lock prevents a second scheduled capture and crash locks fail closed', async t => {
  const pages = await fixture(); let release, started;
  const ready = new Promise(resolve => { started = resolve; }), hold = new Promise(resolve => { release = resolve; });
  const c = await context(t, async (_req, res, i) => { if (i === 1) { started(); await hold; } res.end(JSON.stringify(pages[i - 1])); });
  const first = backupLocal(c.options); await ready;
  await rejection(c.options, 'busy'); assert.equal(c.requests.length, 1); release(); await first;
  assert.ok(!(await readdir(c.destination)).includes('.backup-local.lock'));
  await writeFile(path.join(c.destination, '.backup-local.lock'), '{"pid":99999999}', {mode: 0o600});
  await rejection(c.options, 'busy'); assert.equal(c.requests.length, pages.length);
});

test('private paths reject open permissions, symlinks, source checkouts, and public roots before network access', async t => {
  const c = await context(t);
  await chmod(c.destination, 0o755); await rejection(c.options, 'private_path'); await chmod(c.destination, 0o700);
  await chmod(c.tokenFile, 0o640); await rejection(c.options, 'private_path'); await chmod(c.tokenFile, 0o600);
  const shortcut = path.join(c.root, 'shortcut'); await symlink(c.destination, shortcut); await rejection({...c.options, destination: shortcut}, 'private_path');
  const ancestor = path.join(c.root, 'ancestor'); await symlink(c.root, ancestor); await rejection({...c.options, destination: path.join(ancestor, 'snapshots')}, 'private_path');
  const credentialLink = path.join(c.root, 'credential-link'); await symlink(c.tokenFile, credentialLink); await rejection({...c.options, tokenFile: credentialLink}, 'private_path');
  const source = path.join(c.root, 'source'); await mkdir(source, {mode: 0o700}); await mkdir(path.join(source, '.git')); await writeFile(path.join(source, '.git', 'HEAD'), 'ref: refs/heads/main\n'); await mkdir(path.join(source, 'private'), {mode: 0o700});
  await rejection({...c.options, destination: path.join(source, 'private')}, 'private_path');
  const publicDirectory = path.join(c.root, 'public'); await mkdir(publicDirectory, {mode: 0o700}); await rejection({...c.options, destination: publicDirectory}, 'private_path');
  assert.equal(c.requests.length, 0); await noSnapshot(c.destination);
});

test('a preexisting output symlink is never followed or overwritten', async t => {
  const c = await context(t), target = path.join(c.root, 'untouched'); await writeFile(target, 'untouched', {mode: 0o600});
  const name = `task-board-backup-${when.replaceAll(':', '-')}-${c.pages[0].backupId}.json`;
  await symlink(target, path.join(c.destination, name)); await rejection(c.options, 'destination');
  assert.equal(await readFile(target, 'utf8'), 'untouched'); assert.deepEqual(await readdir(c.destination), [name]);
});

test('safety budgets fail closed without truncated success', async t => {
  for (const limits of [{maxPages: 1}, {maxPageBytes: 1}, {maxTotalBytes: 1}]) {
    const c = await context(t); await rejection({...c.options, ...limits}, 'limit'); await noSnapshot(c.destination);
  }
});

test('configuration rejects insecure remote origins and credentials in URLs or multiple sources', async t => {
  const c = await context(t);
  for (const origin of ['http://example.invalid', 'https://user:secret@example.invalid', 'https://example.invalid/?secret=x', 'https://example.invalid/path', 'file:///tmp/private']) await rejection({...c.options, origin}, 'configuration');
  await rejection({...c.options, token}, 'credentials'); await rejection({...c.options, tokenFile: undefined}, 'credentials');
  await rejection({...c.options, tokenFile: undefined, token: 'bad\r\nX-Leak: value'}, 'credentials');
  assert.equal(c.requests.length, 0);
});

test('direct environment token source captures without a credential file', async t => {
  const c = await context(t), out = await backupLocal({...c.options, tokenFile: undefined, token});
  assert.equal(out.complete, true); assert.ok(c.requests.every(r => r.headers.authorization === `Bearer ${token}`));
});

test('CLI supports environment credentials and never prints response bodies, tokens, headers, or private origins', async t => {
  const c = await context(t, (req, res) => { res.writeHead(401); res.end(JSON.stringify({echo: req.headers.authorization, privateOrigin: 'https://fictional-private.example.invalid'})); });
  const child = spawn(process.execPath, ['--experimental-transform-types', '--import', './tests/loader.mjs', 'scripts/backup-local.mjs'], {cwd: process.cwd(), env: {...process.env, NODE_NO_WARNINGS: '1', TASK_BOARD_BACKUP_ORIGIN: c.origin, TASK_BOARD_BACKUP_DIRECTORY: c.destination, TASK_BOARD_BACKUP_TOKEN_FILE: c.tokenFile, TASK_BOARD_BACKUP_TOKEN: '', TASK_BOARD_BACKUP_ALLOW_LOOPBACK: '1'}, stdio: ['ignore', 'pipe', 'pipe']});
  let output = ''; child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
  const [code] = await once(child, 'close'); assert.equal(code, 1); assert.match(output, /Backup authorization failed/);
  for (const secret of [token, c.tokenFile, c.origin, 'fictional-private.example.invalid', 'Authorization', 'Bearer']) assert.ok(!output.includes(secret));
  await noSnapshot(c.destination);
});
