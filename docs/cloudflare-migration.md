# One-time migration into the production Worker

`scripts/migrate-cloudflare.mjs` transfers one owner's verified v3 migration capture into the production Worker's existing D1 database and private R2 bucket. Routine CI deployments never call it, import tasks, reset records or replace this capture. This is a separate, explicitly authorized operation under the [cutover runbook](oauth-cutover.md).

Prepare the auth-preserving legacy Site migration release first. Freeze source mutations and uploads, drain accepted work, resolve pending upload reservations, and download every page using the separate **Migration backup** action or authenticated `export_migration_page`. Ordinary complete backups remain v2 and cannot supply original upload retry state. Keep the original v3 file untouched and rehearse its isolated recovery before remote transfer.

The v3 private manifest supplies the authoritative legacy `storageOwner`, its `ownerTag` hash, original attachment retry keys/fingerprints and expected counts. The importer verifies the complete chain, relationships, revision histories, every PNG and owner-derived attachment ID before contacting Cloudflare. The destination authentication policy must explicitly bind the verified production principal to that exact storage owner. The importer does not re-key owners or infer identity from email.

## Private CLI configuration

Use Node 22.13+ with installed source dependencies. Capture and credential files must be absolute, owner-only regular files (`0600` or `0400`) outside source checkouts and public/build directories, with no symlink in any path component. Keep them in an owner-only private local directory. The importer does not change permissions or create credentials.

The following values are placeholders and must identify the approved existing production target:

```sh
TASK_BOARD_MIGRATION_FILE=/private/task-board/owner-v3.json \
CLOUDFLARE_ACCOUNT_ID=approved-account-id \
CLOUDFLARE_API_TOKEN_FILE=/private/task-board/cloudflare-token \
TASK_BOARD_D1_DATABASE_ID=approved-database-uuid \
TASK_BOARD_D1_DATABASE_NAME=task-board-db \
TASK_BOARD_R2_BUCKET_NAME=task-board-images \
TASK_BOARD_PRODUCTION_ORIGIN=https://task-board.owner-subdomain.workers.dev \
TASK_BOARD_MIGRATION_APPROVED=true \
node --experimental-transform-types --import ./tests/loader.mjs scripts/migrate-cloudflare.mjs
```

The credential file contains only the already authorized Cloudflare bearer token, optionally followed by a newline. Alternatively supply `CLOUDFLARE_API_TOKEN` through a private environment; never set both sources. Do not put credentials in command-line arguments, source control or logs. Use the narrowest approved access that supports inspecting the named Worker/account subdomain, D1 queries, and private R2 bucket/domain/object operations. This command creates no account, access grant, database, bucket or production identity.

`TASK_BOARD_STORAGE_OWNER` is optional. When omitted, the owner comes only from the locally verified v3 manifest. When supplied, it must match that manifest exactly. A different or empty owner fails before any remote request. The capture may be the private `{format:"task-board-local-backup",version:3,pages:[...]}` wrapper or its complete page array.

The production Worker name is `task-board`, with the stable origin `https://task-board.<approved-account-subdomain>.workers.dev`. The importer verifies the account subdomain, actual D1 UUID/name, Worker `DB` binding, bucket name, Worker `IMAGES` binding, exact `TASK_BOARD_ORIGIN` and `TASK_BOARD_READ_ONLY=true`. Managed and custom public R2 domains must all be disabled. It refuses a mismatched or writable destination before migration writes and repeats these checks during transfer. Apply compatible additive schema migrations through the production deployment first; this importer transfers data only.

## Resume and verification

The destination owner must have no rows in any of the six application tables unless `task_board_migration_state` already identifies this exact capture digest, storage owner and counts. Other owners' rows and image namespaces are left untouched. The migration marker is the only additional system table created by this operation.

For each PNG, an existing object must match its expected size and SHA-256. A missing object is uploaded and then read back; a conflicting object is refused. Parameterized SQL inserts preserve every payload, task/comment history key and fingerprint, snapshot, original upload retry field and owner-derived object key. Existing records are never updated to make a conflict disappear. Readback follows all owner-scoped rows in bounded pages and compares complete canonical records. The marker becomes complete only after records/images and the frozen target are verified; it is read back again before success is reported.

An interrupted transfer may leave a pending marker, verified objects and a subset of the correct rows. Keep application writes disabled and rerun with the **same original capture and configuration**. Exact existing rows are accepted and inserts do not duplicate them. A newly downloaded capture has a different digest even if its visible task content looks identical, and is refused as a different migration. A complete rerun verifies the destination again; altered rows or images are rejected instead of silently repaired.

Success reports counts, the capture digest internally, the production MCP URL and `readOnly:true`. The CLI prints only completion counts/endpoint/read-only state; it never prints the owner, task content, image bytes, token or capture filename. Success does not enable writes or prove production browser/external-agent OAuth. Complete the live browser/API/agent and original-upload retry checks in [oauth-cutover.md](oauth-cutover.md), then validate a destination v3 capture and its isolated recovery before the separately authorized write activation. Keep the legacy Site read-only for rollback.

## Hosted R2 gate

The R2 object GET/PUT endpoint and `cf-r2-data-catalog-check` header match the locked Wrangler implementation. PUT additionally sends `If-None-Match: *`; a `412` response triggers readback verification rather than being assumed successful. The synthetic transport tests prove this handling, but do not establish that Cloudflare's hosted account API honors that precondition.

Before real-data transfer, test the actual approved private bucket with fictional PNGs: verify initial upload/readback, an existing-object precondition with different bytes, and unchanged original bytes after refusal. Record only fixture IDs/hashes and results privately. If hosted conditional behavior differs, resolve the storage write procedure before relying on atomic overwrite protection. The importer already refuses known conflicts and requires a frozen target plus the same-capture marker; those checks do not prove an unverified vendor precondition.

Run the no-network SQL/transport tests with:

```sh
node --experimental-transform-types --import ./tests/loader.mjs tests/cloudflare-migration.test.mjs
```

These tests cover exact record/image/retry preservation, uncertain partial-write resume, complete reruns, unrelated owners, nonempty targets, capture/owner/version refusal before remote access, object conflicts, write-lock changes, full paginated readback, marker corruption, redirects, network failures and private file constraints. Live account/OAuth/TLS/client acceptance remains a separate gate.
