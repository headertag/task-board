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
CLOUDFLARE_API_TOKEN_ID=approved-api-token-id \
TASK_BOARD_D1_DATABASE_ID=approved-database-uuid \
TASK_BOARD_D1_DATABASE_NAME=task-board-db \
TASK_BOARD_R2_BUCKET_NAME=task-board-images \
TASK_BOARD_PRODUCTION_ORIGIN=https://task-board.owner-subdomain.workers.dev \
TASK_BOARD_MIGRATION_APPROVED=true \
node --experimental-transform-types --import ./tests/loader.mjs scripts/migrate-cloudflare.mjs
```

The credential file contains only the already authorized Cloudflare bearer token, optionally followed by a newline. Alternatively supply `CLOUDFLARE_API_TOKEN` through a private environment; never set both sources. `CLOUDFLARE_API_TOKEN_ID` is the token's exact 32-character hexadecimal ID from its approved creation record, distinct from the account ID. It is required for signed S3 requests. Do not put credentials in command-line arguments, source control or logs. Use the narrowest approved access that supports inspecting the named Worker/account subdomain, D1 queries, and private R2 bucket/domain/object operations. This command creates no account, access grant, database, bucket or production identity.

Metadata inspection and D1 use Cloudflare's account REST API. Image GET and atomic create-only PUT use `https://<approved-account-id>.r2.cloudflarestorage.com` with AWS Signature V4, region `auto`, and a signed `If-None-Match: *` condition on PUT. Cloudflare documents the S3 access key as the API token ID and its secret as SHA-256 of the token value; the importer derives this secret only in memory from the same approved token. It does not create another key or broaden that token's permissions. Both transports reject redirects or changed response URLs. Jurisdiction-specific buckets need a separately reviewed endpoint configuration; this importer addresses the named default-jurisdiction bucket. [R2 authentication](https://developers.cloudflare.com/r2/api/tokens/), [S3 compatibility](https://developers.cloudflare.com/r2/api/s3/api/).

`TASK_BOARD_STORAGE_OWNER` is optional. When omitted, the owner comes only from the locally verified v3 manifest. When supplied, it must match that manifest exactly. A different or empty owner fails before any remote request. The capture may be the private `{format:"task-board-local-backup",version:3,pages:[...]}` wrapper or its complete page array.

The production Worker name is `task-board`, with the stable origin `https://task-board.<approved-account-subdomain>.workers.dev`. The importer verifies the account subdomain, actual D1 UUID/name, Worker `DB` binding, bucket name, Worker `IMAGES` binding, exact `TASK_BOARD_ORIGIN` and `TASK_BOARD_READ_ONLY=true`. Managed and custom public R2 domains must all be disabled. It refuses a mismatched or writable destination before migration writes and repeats these checks during transfer. Apply compatible additive schema migrations through the production deployment first; this importer transfers data only.

## Resume and verification

The destination owner must have no rows in any of the six application tables unless `task_board_migration_state` already identifies this exact capture digest, storage owner and counts. Other owners' rows and image namespaces are left untouched. The migration marker is the only additional system table created by this operation.

For each PNG, an existing object must match its expected size and SHA-256. A missing object is uploaded and then read back; a conflicting object is refused. Parameterized SQL inserts preserve every payload, task/comment history key and fingerprint, snapshot, original upload retry field and owner-derived object key. Existing records are never updated to make a conflict disappear. Readback follows all owner-scoped rows in bounded pages and compares complete canonical records and the original relative order of task/comment events. Numeric rowids/sequence values may change; history order may not. The marker becomes complete only after records/images and the frozen target are verified; it is read back again before success is reported.

An interrupted transfer may leave a pending marker, verified objects and a subset of the correct rows. Keep application writes disabled and rerun with the **same original capture and configuration**. Exact existing rows are accepted, verified prefixes of history are retained, and already verified rows are skipped when resuming. Inserts do not duplicate them. A newly downloaded capture has a different digest even if its visible task content looks identical, and is refused as a different migration. A complete rerun verifies the destination again; altered rows or images are rejected instead of silently repaired.

Success reports counts, the capture digest internally, the production MCP URL and `readOnly:true`. The CLI prints only completion counts/endpoint/read-only state; it never prints the owner, task content, image bytes, token or capture filename. Success does not enable writes or prove production browser/external-agent OAuth. Complete the live browser/API/agent and original-upload retry checks in [oauth-cutover.md](oauth-cutover.md), then validate a destination v3 capture and its isolated recovery before the separately authorized write activation. Keep the legacy Site read-only for rollback.

## Hosted R2 gate

Do not use the Dashboard/Wrangler account REST object PUT endpoint for atomic overwrite protection: a hosted fictional probe accepted a conflicting PUT despite `If-None-Match: *` and replaced the fictional bytes. The importer uses the documented S3 conditional PUT interface instead. A `412` response triggers exact readback verification rather than being assumed successful. [Cloudflare's S3 compatibility reference](https://developers.cloudflare.com/r2/api/s3/api/) lists conditional operations for `PutObject`; its [REST Upload Object reference](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/objects/methods/upload/) does not specify write preconditions.

Before real-data transfer, test the actual approved private bucket through the signed S3 interface with fictional PNGs in a unique `migration-fixtures/` namespace. Verify a missing-key GET, initial conditional upload/readback, a changed-input conditional PUT returning `412`, and unchanged original bytes after refusal. Recheck the named frozen/private target before each write. Record only fixture IDs/hashes and results privately. A hosted signed-S3 probe established this behavior for the approved installation; another target or credential still needs its own gate. Any mismatch blocks real migration. Never weaken the condition, fall back to REST uploads, or treat a frozen target and same-capture marker as substitutes for atomic create-only semantics.

Run the no-network SQL/transport tests with:

```sh
node --experimental-transform-types --import ./tests/loader.mjs tests/cloudflare-migration.test.mjs
```

These tests cover exact record/image/retry preservation, uncertain partial-write resume, complete reruns, unrelated owners, nonempty targets, capture/owner/version refusal before remote access, object conflicts, write-lock changes, full paginated readback, marker corruption, redirects, network failures, private file constraints, explicit token IDs and AWS's published Signature V4 golden example. Live account/OAuth/TLS/client acceptance remains a separate gate.
