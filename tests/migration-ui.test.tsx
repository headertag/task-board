import { JSDOM } from 'jsdom';
import assert from 'node:assert/strict';
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLFormElement', 'HTMLSelectElement', 'HTMLTextAreaElement', 'HTMLAnchorElement', 'Element', 'Node', 'NodeFilter', 'MutationObserver', 'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'DocumentFragment', 'getComputedStyle']) {
  Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true });
}
(globalThis as any).requestAnimationFrame = (fn: any) => setTimeout(fn, 0);
(globalThis as any).cancelAnimationFrame = clearTimeout;
(globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} } as any);
const React = await import('react'); (globalThis as any).React = React;
const { render, screen, fireEvent, waitFor, cleanup } = await import('@testing-library/react');
const { default: Board } = await import('../app/board');
const { hash, stable } = await import('../lib/safety');
async function emptyCapture(version: 2 | 3) {
  const storageOwner = 'synthetic-ui-source-owner';
  const ownerTag = await hash(storageOwner);
  const first: any = { format: 'task-board-backup-page', version, backupId: crypto.randomUUID(), capturedAt: new Date().toISOString(), sequence: 0, previousChecksum: null,
    ...(version === 3 ? { ownerTag, storageOwner, uploadRetries: [] } : {}), pageKind: 'manifest', tasks: [], history: [], snapshots: [], commentHistory: [], attachments: [], attachmentParts: [],
    counts: { tasks: 0, history: 0, snapshots: 0, comments: 0, commentHistory: 0, attachments: 0, attachmentParts: 0, attachmentBytes: 0, ...(version === 3 ? { uploadRetries: 0 } : {}) }, complete: false };
  first.checksum = await hash(stable(first)); first.nextCursor = 'next-fictional-page';
  const last: any = { format: first.format, version, backupId: first.backupId, capturedAt: first.capturedAt, sequence: 1, previousChecksum: first.checksum,
    ...(version === 3 ? { ownerTag } : {}), pageKind: 'images', tasks: [], history: [], snapshots: [], commentHistory: [], attachments: [], attachmentParts: [], complete: true };
  last.checksum = await hash(stable(last)); last.nextCursor = null;
  return [first, last];
}
const v2 = await emptyCapture(2), v3 = await emptyCapture(3);
let corruptMigration = false;
const downloads: { blob: Blob, filename?: string }[] = [];
URL.createObjectURL = blob => { assert.ok(blob instanceof Blob); downloads.push({ blob }); return 'blob:fictional-backup'; };
URL.revokeObjectURL = () => {};
HTMLAnchorElement.prototype.click = function () { downloads.at(-1)!.filename = this.download; };
const operations: string[] = [];
(globalThis as any).fetch = async (_url: string, options: any) => {
  const { name, args } = JSON.parse(options.body); operations.push(name);
  if (name === 'list_snapshots') return Response.json({ snapshots: [] });
  if (name === 'export_migration_page' || name === 'export_backup_page') {
    const page = structuredClone((name === 'export_migration_page' ? v3 : v2)[args.cursor ? 1 : 0]);
    if (name === 'export_migration_page' && corruptMigration && args.cursor) page.checksum = '0'.repeat(64);
    return Response.json(page);
  }
  if (name === 'seed_samples' || name === 'list_tasks') return Response.json({ tasks: [] });
  throw new Error('Unexpected operation ' + name);
};
render(<Board canWrite={false} />);
await waitFor(() => assert.ok(screen.queryByText('Loading saved tasks…') === null));
assert.deepEqual(operations, ['list_tasks', 'list_tasks']);
assert.ok(screen.getByText('This board is read-only. You can view and export saved records.'));
assert.equal((screen.getByRole('button', { name: 'New task' }) as HTMLButtonElement).disabled, true);
fireEvent.click(screen.getByRole('button', { name: 'Open recovery and import tools' }));
const migrationButton = await screen.findByRole('button', { name: 'Download migration backup (v3)' });
assert.equal((migrationButton as HTMLButtonElement).disabled, false);
fireEvent.click(migrationButton);
await waitFor(() => assert.equal(downloads.length, 1));
let downloaded = JSON.parse(await downloads[0].blob.text());
assert.equal(downloaded.format, 'task-board-local-backup'); assert.equal(downloaded.version, 3); assert.equal(downloaded.pages.length, 2);
assert.ok(downloads[0].filename?.startsWith('task-board-migration-'));
assert.equal(operations.filter(name => name === 'export_migration_page').length, 2);
await screen.findByRole('button', { name: 'Download migration backup (v3)' });
corruptMigration = true;
fireEvent.click(screen.getByRole('button', { name: 'Download migration backup (v3)' }));
await screen.findByText('Backup checksum mismatch');
assert.equal(downloads.length, 1, 'corrupt or incomplete capture must never download');
fireEvent.click(screen.getByRole('button', { name: 'Download complete backup' }));
await waitFor(() => assert.equal(downloads.length, 2));
downloaded = JSON.parse(await downloads[1].blob.text());
assert.equal(downloaded.format, 'task-board-complete-backup'); assert.equal(downloaded.version, 2);
assert.equal(operations.filter(name => name === 'export_backup_page').length, 2);
console.log('PASS frozen browser v3 download follows every cursor and validates before saving; corrupt v3 is refused and normal v2 download remains separate');

cleanup(); operations.length = 0;
render(<Board />);
await waitFor(() => assert.ok(screen.queryByText('Loading saved tasks…') === null));
assert.deepEqual(operations, ['seed_samples', 'list_tasks', 'list_tasks']);
assert.equal((screen.getByRole('button', { name: 'New task' }) as HTMLButtonElement).disabled, false);
fireEvent.click(screen.getByRole('button', { name: 'Open recovery and import tools' }));
assert.equal((await screen.findByRole('button', { name: 'Download migration backup (v3)' }) as HTMLButtonElement).disabled, true);
cleanup();
console.log('PASS frozen empty-board UI reads without seeding; writable board keeps sample initialization');
