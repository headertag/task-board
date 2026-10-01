# Private exports and recovery

Task data, images and backup files are private. Keep them outside source control. The public source contains no real records.

## Backup and migration formats

- **Portable task export (version 2)** includes tasks, comments, their history and normalized PNG images, up to 750 KB UTF-8, 100 tasks and 2,000 events of each kind. Version-1 task-only files remain importable. Preview validates task fields, comment relationships, image bytes/dimensions and checksums before changes. Imports create copies with new IDs and remapped image/comment references; original histories remain in the source snapshot. Reuse the same request key to resume a partial copy import. Existing records are never replaced.
- **Complete backup (version 2)** captures task records and append-only history boundaries in one database batch, then returns a checksum-chained sequence of pages. This includes all task/comment revisions and their mutation request keys/fingerprints, recoverable removals, snapshots, completed attachments and every corresponding PNG byte, including retained unattached drafts. Only upload rows marked `ready=1` are captured. Original attachment upload request keys/fingerprints and unfinished reservations are not included; complete v2 is content/history recovery, not a raw database clone or proof of original upload retry continuity. Follow `nextCursor` until `complete` is true and validate the whole chain, counts and image SHA-256 checksums. The UI does this before offering the download. Old version-1 cursors remain readable, but a new complete backup uses version 2.

- **Migration capture (version 3)** is a separate `export_migration_page` operation. It retains all v2 content plus the authoritative canonical `storageOwner`, its SHA-256 `ownerTag`, and one `uploadRetries` entry per completed attachment containing its original `requestKey` and `fingerprint`. The private manifest carries the raw storage owner required for migration; the validator verifies its hash, and every v3 page includes the same owner tag. The manifest counts retry entries. It refuses incomplete upload reservations, inconsistent retry metadata or owner-derived attachment IDs, and its signed cursors cannot be used with v2. Continuations also reject new task/comment/snapshot/upload writes after the manifest, rather than silently omitting them. Capture only after the source is read-only and accepted writes/uploads have drained. Ordinary v2 exports and their wire format remain unchanged.

Use `export_backup_page` for ordinary backups and `export_migration_page` for approved migrations. Pages contain `sequence`, `previousChecksum`, `checksum`, a stable `backupId`, and first-page counts. Image bytes are delivered in 64 KiB parts. An error or missing page means the backup is incomplete. Cursor HMACs are owner-specific; every database and blob read requires the authenticated owner. Internal signing keys are not user data and are regenerated in a recovered installation.

## Private local capture

`scripts/backup-local.mjs` downloads every v2 page by default, or every v3 migration page with explicit `TASK_BOARD_BACKUP_MODE=migration` through the authenticated `/api/board` operation, then uses the same complete-backup validator as offline recovery. It checks page order, checksum chaining, manifest counts, task/comment revision chains, relationships, image parts, full image hashes and PNG dimensions. It includes Trash, removed comments, snapshots and retained unattached image uploads. It publishes no file until the entire capture validates.

Use an existing owner-only directory outside every source checkout and web-served/public directory. The script rejects group/other permissions, a different filesystem owner, symbolic links in any path component, Git checkout paths and common public/build roots. It does not create the destination or change existing permissions. The published JSON uses mode `0600`; directories must use `0700`. Keep the directory on a private local filesystem that supports hard links and filesystem synchronization. Public shares and automatically published or cloud-synchronized directories are unsuitable even when their local permissions look private.

Set `TASK_BOARD_BACKUP_MODE=migration` only for an intentional frozen-source migration capture. It selects `export_migration_page` and refuses a v2 response; omitted mode or `backup` selects v2. The CLI does not freeze the source. A legacy Sites source needs its existing authorized browser/API/MCP session for this separate operation when bearer authentication is unavailable.

The examples below are placeholders. Creating a credential, granting a client access, selecting a real backup destination, and enabling a schedule require the owner's authorization. The source contains no real account, origin, token or backup location.

```sh
TASK_BOARD_BACKUP_ORIGIN=https://board.example.invalid \
TASK_BOARD_BACKUP_DIRECTORY=/home/example/.local/state/task-board/backups \
TASK_BOARD_BACKUP_TOKEN_FILE=/home/example/.local/state/task-board/access-token \
node --experimental-transform-types --import ./tests/loader.mjs scripts/backup-local.mjs
```

The credential file contains only an already authorized bearer access token, with an optional final newline. It must be a regular owner-only file (`0600` or `0400`), outside source/public directories, with no symlink components. Alternatively, supply `TASK_BOARD_BACKUP_TOKEN` through a private environment; do not set both credential sources. Never put a token in command-line arguments, a URL, source control or scheduler logs. This command does not register an OAuth client, request a new grant, refresh credentials, sign into a legacy hosting service, or create a service account. An expired, revoked or newly disallowed identity fails closed, so an authorized credential renewal procedure is required before unattended use can be considered operational. A legacy source must be captured through its existing authorized complete-backup UI or API/MCP path when this bearer route is unavailable.

Only HTTPS origins are accepted. The script refuses all redirects, including redirects to the same origin, so its authorization header never follows a redirect. Cookies, caller-provided identity headers and URL credentials are not used. `TASK_BOARD_BACKUP_ALLOW_LOOPBACK=1` permits HTTP solely on loopback for fictional local tests; it never permits HTTP to a remote host.

Each run takes `.backup-local.lock` before downloading. Overlap exits with status `75` and leaves the active capture alone. A crash can leave a lock: confirm that its recorded process has ended and that no scheduler run is active before removing it. Locks are never automatically stolen. Successful output is a new `task-board-backup-<capture-time>-<backup-id>.json` snapshot; atomic publication never replaces an existing filename or follows an output symlink. Failed downloads and validation errors leave earlier snapshots intact. A crash can leave a private `.partial` file, which is not a complete backup. Keep the last known verified snapshot until a new capture and recovery rehearsal have passed. The CLI logs only a fixed success or failure message, never response bodies, tokens, cursors, record text, private origins or filenames.

Optional safety limits are `TASK_BOARD_BACKUP_PAGE_SIZE` (default `20`, maximum `100`), `TASK_BOARD_BACKUP_TIMEOUT_MS` (per request; default `30000`), `TASK_BOARD_BACKUP_MAX_PAGES` (default `100000`), `TASK_BOARD_BACKUP_MAX_PAGE_BYTES` (default `16777216`) and `TASK_BOARD_BACKUP_MAX_TOTAL_BYTES` (default `536870912`). Exceeding a limit fails the capture; it never produces a truncated successful backup. Validation holds the complete chain and image bytes in memory. Review resource limits for very large histories before raising these bounds.

### Scheduling example, not installed

An owner-reviewed systemd user timer can run this command against a private local path. Store the following environment settings in a private `0600` file, for example `/home/example/.config/task-board/backup.env`; the token itself belongs in the separate private token file:

```ini
TASK_BOARD_BACKUP_ORIGIN=https://board.example.invalid
TASK_BOARD_BACKUP_DIRECTORY=/home/example/.local/state/task-board/backups
TASK_BOARD_BACKUP_TOKEN_FILE=/home/example/.local/state/task-board/access-token
```

Example `task-board-backup.service`:

```ini
[Unit]
Description=Verified private task board backup

[Service]
Type=oneshot
WorkingDirectory=/path/to/task-board
EnvironmentFile=/home/example/.config/task-board/backup.env
ExecStart=/path/to/node --experimental-transform-types --import /path/to/task-board/tests/loader.mjs /path/to/task-board/scripts/backup-local.mjs
UMask=0077
NoNewPrivileges=true
```

Example `task-board-backup.timer`:

```ini
[Unit]
Description=Daily private task board backup

[Timer]
OnCalendar=*-*-* 03:15:00 UTC
Persistent=true
Unit=task-board-backup.service

[Install]
WantedBy=timers.target
```

Review the actual owner, paths, cadence, credential-renewal plan, retention and failure reporting before installing or enabling these units. A timer file or a successful synthetic test alone does not establish a working production backup schedule. The script never purges snapshots; any retention/deletion policy needs separate approval. Run the fictional local-server verification with:

```sh
node --experimental-transform-types --import ./tests/loader.mjs --test tests/backup-local.test.mjs
```

Before calling an installed schedule operational, run a capture and isolated restore through its actual private paths, test an expired credential failure without losing the last verified snapshot, verify overlap handling and confirm that the approved failure reporting reaches the owner. Keep the token renewal procedure independent of browser session expiry. Installation and any external notification action require their own authorized scope; the repository supplies neither an installed timer nor an automatic refresh grant.

## Exact isolated recovery

Requires Node 22.13+ with built-in SQLite and the source dependencies installed. First make a copy of the backup and keep the original untouched. Run from the project root:

```
node --experimental-transform-types --import ./tests/loader.mjs scripts/recover-backup.mjs /private/backup.json /private/new-recovery synthetic-or-authorized-owner-id
```

The raw v3 storage owner is private account evidence and belongs only in the owner-authorized capture/configuration, never public logs or repository data.

The script accepts complete v2 or v3 captures and validates every page, history revision, relationship and normalized PNG before writing. V3 recovery additionally verifies that the supplied owner hashes to the captured `ownerTag` and that each attachment ID is derived from that exact owner and original upload key. These checks happen before any output writes; re-keying the storage owner is refused for v3. It creates an isolated SQLite database plus a private object directory, preserving IDs, revisions, timestamps, task/comment history and snapshots. It does not contact or modify the live Site. The destination must be absent or an owner-only private directory. An existing directory with group/other access or a symbolic link is rejected; the tool does not change pre-existing permissions. Database files are created owner-only. A nonempty destination must belong to this exact recovery. Same-file retries are idempotent; a different backup/owner or existing unrelated database is rejected. Blob writes are restartable and SQL records are committed atomically. State updates use atomic rename with filesystem synchronization. Every retry re-verifies all restored rows and image bytes, even when a completion marker already exists; changed recovery data is rejected rather than overwritten.

The object files correspond to the `images/<owner hash>/<attachment ID>` keys recorded in the database. V2 recovery deliberately substitutes attachment upload `request_key=recovered:<attachment-id>` and `fingerprint=<image SHA-256>` because complete v2 lacks the original values. These are not the production upload fingerprint, which includes task ID, normalized image digest and filename. Same-owner retries under an original upload key can therefore conflict; remapping the storage owner changes the derived upload ID and can create a second attachment. Image content and ID recovery do not establish upload retry continuity.

V3 recovery instead restores the original attachment upload `request_key` and `fingerprint` unchanged. Synthetic tests prove identical original-key retries return the original attachment, changed input is rejected and incomplete reservations block capture. Retain the legacy storage owner in the destination authentication policy; changing an OAuth identity does not require changing that storage key. A v2-restored board with substituted retry fields cannot produce an authoritative v3 migration capture.

An actual live deployment recovery additionally requires an owner-scoped database/object migration and verification. This offline command is not a live restore endpoint, a remote D1 importer or a two-database merge, and does not claim managed point-in-time recovery. Use the separately reviewed production importer and acceptance gates in [docs/production-deployment.md](docs/production-deployment.md); a local SQLite file alone is not a remote restore. V3 adds a separate contract and leaves the live v2 export unchanged.

Preserve import snapshot IDs/payloads and their source request-key relationships; they guard repeated imports. Attachment-bearing import retries also depend on original upload retry state, which v3 preserves and v2 omits. Numeric rowids/comment sequence values may be regenerated during recovery and must not identify a boundary across installations.

For an OAuth hosting cutover, use a complete v3 migration capture and same-storage-owner isolated recovery for upload retry continuity. V2 remains available for ordinary content/history recovery but cannot supply original upload retries. Portable imports deliberately assign new IDs and are unsuitable for preserving existing MCP record references. The immutable-principal mapping, live acceptance gate, capture/migration/readback order and rollback reconciliation are specified in [docs/oauth-cutover.md](docs/oauth-cutover.md). A production request does not establish that those release gates have passed.

## Full-data migration and readback

Keep source and destination application writes disabled while draining uploads, taking the final source capture and preparing the migration. Retain the untouched source v3 migration capture, with private whole-file/object digests and expected counts. Incomplete upload reservations must be resolved before capture; they are never silently omitted from a successful migration. Restore a copy offline under the explicit owner mapping and repeat recovery before preparing a reviewed SQL/object package for the exact destination owner. Preserve IDs, task/comment history and request keys, snapshots, attachment retry fields and object namespaces; apply no unrelated owner changes. The live package/importer must be reviewed and executed under the exact production scope, as described in [docs/production-deployment.md](docs/production-deployment.md). Require v3 and the unchanged legacy storage owner; do not treat copy import or a v2 recovery as a full-state migration.

The remote application tool is `scripts/migrate-cloudflare.mjs`. Configure the reviewed source v3 file, exact storage owner, Cloudflare account, D1 database ID/name, private R2 bucket, production origin and credential through private environment/files, then set the explicit migration approval flag. Its approved target and read-only checks, empty-owner/identical-retry marker, object hashes and row readback are additional release gates. Follow [docs/cloudflare-migration.md](docs/cloudflare-migration.md) for private CLI configuration, exact retry behavior and the hosted R2 precondition gate; these identifiers and credentials do not belong in Git or operational logs.

Read back the destination with its approved production identity policy through browser/API and the actual consented read-only agent. Compare canonical payloads, IDs, revisions, timestamps, ordered histories and mutation keys/fingerprints, Trash, removed comments, snapshots, retained drafts and every PNG byte/hash against the source. Validate a new complete v3 destination capture and its offline restore, and verify original upload retry keys and changed-input rejection. New capture IDs/timestamps/checksum chains differ, so compare logical content rather than whole-file digests. Bounded task-history, snapshot and comment-page APIs cannot prove complete counts or unattached draft coverage; use the full capture and reviewed owner-scoped destination rows. Missing hosted image bytes, incomplete TLS/OAuth/browser verification, demo/staging identity assumptions or absent authoritative v3 retry metadata leave migration/cutover blocked.

After destination writes begin, a rollback must preserve a complete after-boundary v3 migration capture. Reconcile its new records/events/images with the untouched source boundary before reopening writes. A successful recovery of the later sole-writer capture is not proof of merging divergent writable boards; the offline tool performs no such merge. Keep both boards read-only if the reconciliation cannot be verified.

## Storage behavior

Comments have independent revisions, request-key idempotency and append-only history. Removing a comment is recoverable; task Trash preserves comments and images. Uploaded images use private R2 objects and owner-authorized, no-store routes. Browser input accepts PNG/JPEG/WebP, resizes to a maximum 1600px edge, and converts to PNG. Server acceptance is limited to 8-bit RGB/RGBA non-interlaced PNG, 2 MiB, 4 million pixels, exact scanline length, bounded decompression and valid chunk CRCs. A fresh PNG strips embedded metadata; original files are not retained.

Limits: four images per comment, 500 comments per owner, 100 image uploads or 100 MiB per owner including retained unused drafts. Failed upload reservations can be retried with the same key. Removing an image from an unsent draft detaches it from that draft but keeps its private upload in backups. There is no automatic purge or permanent-delete action.
