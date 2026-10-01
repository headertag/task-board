// Private, read-only capture. No credentials in arguments, redirects, or logs.
import {constants} from 'node:fs';
import {open, lstat, link, unlink} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {validateBackup} from '../lib/backup.ts';
import {normalizePng} from '../lib/image.ts';
import {hash, stable} from '../lib/safety.ts';

const messages = {
  configuration: 'Backup configuration is invalid.',
  private_path: 'Backup and credential paths must be private, owned, outside source/public directories, and free of symbolic links.',
  credentials: 'A private credential file or bearer token environment variable is required.',
  busy: 'Another capture owns the backup lock; no backup was started.',
  request: 'Backup request failed; no complete backup was saved.',
  authorization: 'Backup authorization failed; renew the owner-authorized credential.',
  invalid_backup: 'Backup chain, record counts, relationships, or image bytes failed validation; no complete backup was saved.',
  limit: 'Backup exceeded a configured safety limit; no complete backup was saved.',
  destination: 'Backup could not be saved safely; existing snapshots were not replaced.',
};
export class BackupLocalError extends Error {
  constructor(code) { super(messages[code]); this.name = 'BackupLocalError'; this.code = code; }
}
function fail(code) { throw new BackupLocalError(code); }
function integer(value, fallback, min, max) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) fail('configuration');
  return n;
}

// Check every component, including ancestors, without following symlinks.
async function privatePath(filename, directory) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename)) fail('private_path');
  const resolved = path.resolve(filename);
  const components = resolved.split(path.sep).filter(Boolean);
  if (components.some(c => ['public', 'www', 'wwwroot', 'htdocs', 'static', 'dist', 'out'].includes(c.toLowerCase()))) fail('private_path');
  let current = path.parse(resolved).root;
  try {
    for (let i = 0; i < components.length; i++) {
      current = path.join(current, components[i]);
      const info = await lstat(current);
      if (info.isSymbolicLink() || (i < components.length - 1 && !info.isDirectory())) fail('private_path');
      if (info.isDirectory()) {
        try {
          const git = await lstat(path.join(current, '.git'));
          if (!git.isDirectory()) fail('private_path'); // Includes linked worktrees.
          // An empty .git placeholder is not a source checkout.
          await lstat(path.join(current, '.git', 'HEAD')); fail('private_path');
        }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
    const info = await lstat(resolved);
    if ((directory ? !info.isDirectory() : !info.isFile()) || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) fail('private_path');
    return {filename: resolved, info};
  } catch (error) {
    if (error instanceof BackupLocalError) throw error;
    fail('private_path');
  }
}

async function bearer(options) {
  if (!!options.token === !!options.tokenFile) fail('credentials');
  let value = options.token;
  if (options.tokenFile) {
    const checked = await privatePath(options.tokenFile, false);
    let file;
    try {
      file = await open(checked.filename, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await file.stat();
      if (!info.isFile() || info.dev !== checked.info.dev || info.ino !== checked.info.ino || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size > 16385) fail('private_path');
      value = (await file.readFile('utf8')).trim();
    } catch (error) {
      if (error instanceof BackupLocalError) throw error;
      fail('credentials');
    } finally { await file?.close(); }
  }
  if (typeof value !== 'string' || !value || value.length > 16384 || !/^[A-Za-z0-9._~+\/-]+=*$/.test(value)) fail('credentials');
  return value;
}

function endpoint(origin, allowHttpLoopback) {
  try {
    const url = new URL(origin);
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(allowHttpLoopback && url.protocol === 'http:' && loopback)) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) fail('configuration');
    return new URL('/api/board', url);
  } catch { fail('configuration'); }
}

async function responsePage(response, maxBytes) {
  const length = response.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) { await response.body?.cancel(); fail('limit'); }
  if (!response.body) fail('invalid_backup');
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) { await reader.cancel(); fail('limit'); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  try { return {page: JSON.parse(Buffer.concat(chunks).toString('utf8')), size}; }
  catch { fail('invalid_backup'); }
}

async function checkPage(page, pages) {
  const manifest = pages[0] ?? page;
  if (!page || page.format !== 'task-board-backup-page' || page.version !== 2 || page.sequence !== pages.length || page.previousChecksum !== (pages.at(-1)?.checksum ?? null) || page.backupId !== manifest.backupId || page.capturedAt !== manifest.capturedAt || !/^[a-f0-9]{64}$/.test(page.checksum) || typeof page.complete !== 'boolean') fail('invalid_backup');
  if (!pages.length && (page.pageKind !== 'manifest' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(page.backupId) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(page.capturedAt) || !Number.isFinite(Date.parse(page.capturedAt)))) fail('invalid_backup');
  if (page.complete ? page.nextCursor !== null : typeof page.nextCursor !== 'string' || !page.nextCursor || page.nextCursor.length > 300000) fail('invalid_backup');
  const {checksum, nextCursor, ...body} = page;
  if (await hash(stable(body)) !== checksum) fail('invalid_backup');
}

/** Save only a complete validated v2 capture; never overwrite an earlier snapshot. */
export async function backupLocal(options) {
  const url = endpoint(options.origin, options.allowHttpLoopback === true);
  const pageSize = integer(options.pageSize, 20, 1, 100);
  const maxPages = integer(options.maxPages, 100000, 1, 1000000);
  const maxPageBytes = integer(options.maxPageBytes, 16 * 1024 * 1024, 1, 128 * 1024 * 1024);
  const maxTotalBytes = integer(options.maxTotalBytes, 512 * 1024 * 1024, 1, Number.MAX_SAFE_INTEGER);
  const timeoutMs = integer(options.timeoutMs, 30000, 1, 300000);
  const destination = await privatePath(options.destination, true);
  const token = await bearer(options);
  const lockPath = path.join(destination.filename, '.backup-local.lock');
  let lock, temporary, directory, published;
  try {
    try { lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) { fail(error.code === 'EEXIST' ? 'busy' : 'destination'); }
    await lock.writeFile(JSON.stringify({pid: process.pid, startedAt: new Date().toISOString()}));
    await lock.sync();
    const pages = [], cursors = new Set();
    let cursor = null, totalBytes = 0;
    do {
      if (pages.length >= maxPages) fail('limit');
      let response;
      try {
        response = await fetch(url, {
          method: 'POST', redirect: 'manual', credentials: 'omit',
          headers: {'Content-Type': 'application/json', Authorization: `Bearer ${token}`},
          body: JSON.stringify({name: 'export_backup_page', args: {pageSize, ...(cursor === null ? {} : {cursor})}}),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch { fail('request'); }
      if (!response.ok) {
        await response.body?.cancel();
        fail(response.status === 401 || response.status === 403 ? 'authorization' : 'request');
      }
      let downloaded;
      try { downloaded = await responsePage(response, maxPageBytes); }
      catch (error) { if (error instanceof BackupLocalError) throw error; fail('request'); }
      totalBytes += downloaded.size;
      if (totalBytes > maxTotalBytes) fail('limit');
      await checkPage(downloaded.page, pages);
      pages.push(downloaded.page);
      cursor = downloaded.page.nextCursor;
      if (cursor !== null) { if (cursors.has(cursor)) fail('invalid_backup'); cursors.add(cursor); }
    } while (cursor !== null);
    let verified;
    try {
      verified = await validateBackup(pages);
      for (const image of verified.attachments) {
        const normalized = await normalizePng(verified.blobs.get(image.id));
        if (normalized.width !== image.width || normalized.height !== image.height) fail('invalid_backup');
      }
    } catch { fail('invalid_backup'); }
    // Recheck identity and permissions after network work, before touching output.
    const rechecked = await privatePath(destination.filename, true);
    if (rechecked.info.dev !== destination.info.dev || rechecked.info.ino !== destination.info.ino) fail('private_path');
    directory = await open(destination.filename, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const info = await directory.stat();
    if (info.dev !== destination.info.dev || info.ino !== destination.info.ino) fail('private_path');
    const filename = path.join(destination.filename, `task-board-backup-${pages[0].capturedAt.replaceAll(':', '-')}-${pages[0].backupId}.json`);
    temporary = path.join(destination.filename, `.backup-${randomUUID()}.partial`);
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.chmod(0o600); await file.writeFile(JSON.stringify({format: 'task-board-local-backup', version: 2, pages})); await file.sync(); }
    finally { await file.close(); }
    // A hard link publishes atomically with no replacement (unlike rename).
    await link(temporary, filename);
    published = filename;
    await unlink(temporary); temporary = undefined;
    await directory.sync();
    return {filename, complete: true, pageCount: pages.length, counts: verified.manifest.counts};
  } catch (error) {
    if (published) { try { await unlink(published); await directory?.sync(); } catch {} }
    if (error instanceof BackupLocalError) throw error;
    fail('destination');
  } finally {
    if (temporary) { try { await unlink(temporary); } catch {} }
    await directory?.close();
    if (lock) { await lock.close(); await unlink(lockPath); }
  }
}

export function backupOptionsFromEnvironment(env = process.env) {
  return {
    origin: env.TASK_BOARD_BACKUP_ORIGIN, destination: env.TASK_BOARD_BACKUP_DIRECTORY,
    token: env.TASK_BOARD_BACKUP_TOKEN, tokenFile: env.TASK_BOARD_BACKUP_TOKEN_FILE,
    pageSize: env.TASK_BOARD_BACKUP_PAGE_SIZE, maxPages: env.TASK_BOARD_BACKUP_MAX_PAGES,
    maxPageBytes: env.TASK_BOARD_BACKUP_MAX_PAGE_BYTES, maxTotalBytes: env.TASK_BOARD_BACKUP_MAX_TOTAL_BYTES,
    timeoutMs: env.TASK_BOARD_BACKUP_TIMEOUT_MS, allowHttpLoopback: env.TASK_BOARD_BACKUP_ALLOW_LOOPBACK === '1',
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 2) {
    console.error('Usage: configure TASK_BOARD_BACKUP_ORIGIN, TASK_BOARD_BACKUP_DIRECTORY, and TASK_BOARD_BACKUP_TOKEN_FILE (or TASK_BOARD_BACKUP_TOKEN); no command-line credentials.');
    process.exitCode = 1;
  } else {
    try { await backupLocal(backupOptionsFromEnvironment()); console.log('Complete local backup verified and saved.'); }
    catch (error) { console.error(error instanceof BackupLocalError ? error.message : messages.destination); process.exitCode = error.code === 'busy' ? 75 : 1; }
  }
}
