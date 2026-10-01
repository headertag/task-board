# Private exports and recovery

Task data, images and backup files are private. Keep them outside source control. The public source contains no real records.

## Two formats

- **Portable task export (version 2)** includes tasks, comments, their history and normalized PNG images, up to 750 KB UTF-8, 100 tasks and 2,000 events of each kind. Version-1 task-only files remain importable. Preview validates task fields, comment relationships, image bytes/dimensions and checksums before changes. Imports create copies with new IDs and remapped image/comment references; original histories remain in the source snapshot. Reuse the same request key to resume a partial copy import. Existing records are never replaced.
- **Complete backup (version 2)** captures task records and append-only history boundaries in one database batch, then returns a checksum-chained sequence of pages. This includes all comment revisions, recoverable removals, retained image uploads, snapshots and every image byte. Follow `nextCursor` until `complete` is true and validate the whole chain, counts and image SHA-256 checksums. The UI does this before offering the download. Old version-1 cursors remain readable, but a new complete backup uses version 2.

Use `export_backup_page` for new captures. Pages contain `sequence`, `previousChecksum`, `checksum`, a stable `backupId`, and first-page counts. Image bytes are delivered in 64 KiB parts. An error or missing page means the backup is incomplete. Cursor HMACs are owner-specific; every database and blob read requires the authenticated owner. Internal signing keys are not user data and are regenerated in a recovered installation.

## Exact isolated recovery

Requires Node 22.13+ with built-in SQLite and the source dependencies installed. First make a copy of the backup and keep the original untouched. Run from the project root:

```
node --experimental-transform-types --import ./tests/loader.mjs scripts/recover-backup.mjs /private/backup.json /private/new-recovery synthetic-or-authorized-owner-id
```

The script validates every page, history revision, relationship and normalized PNG before writing. It creates an isolated SQLite database plus a private object directory, preserving IDs, revisions, timestamps, task/comment history and snapshots. It does not contact or modify the live Site. The destination must be absent or an owner-only private directory. An existing directory with group/other access or a symbolic link is rejected; the tool does not change pre-existing permissions. Database files are created owner-only. A nonempty destination must belong to this exact recovery. Same-file retries are idempotent; a different backup/owner or existing unrelated database is rejected. Blob writes are restartable and SQL records are committed atomically. State updates use atomic rename with filesystem synchronization. Every retry re-verifies all restored rows and image bytes, even when a completion marker already exists; changed recovery data is rejected rather than overwritten.

The object files correspond to the `images/<owner hash>/<attachment ID>` keys recorded in the database. An actual live deployment recovery requires an explicit owner-authorized database/object migration and verification; this offline command is not a live restore endpoint and does not claim managed point-in-time recovery.

## Storage behavior

Comments have independent revisions, request-key idempotency and append-only history. Removing a comment is recoverable; task Trash preserves comments and images. Uploaded images use private R2 objects and owner-authorized, no-store routes. Browser input accepts PNG/JPEG/WebP, resizes to a maximum 1600px edge, and converts to PNG. Server acceptance is limited to 8-bit RGB/RGBA non-interlaced PNG, 2 MiB, 4 million pixels, exact scanline length, bounded decompression and valid chunk CRCs. A fresh PNG strips embedded metadata; original files are not retained.

Limits: four images per comment, 500 comments per owner, 100 image uploads or 100 MiB per owner including retained unused drafts. Failed upload reservations can be retried with the same key. Removing an image from an unsent draft detaches it from that draft but keeps its private upload in backups. There is no automatic purge or permanent-delete action.
