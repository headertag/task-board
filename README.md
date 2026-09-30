# Task Board

A small full-stack task board with an amber CRT-inspired interface, durable Cloudflare D1 storage, and a stateless remote MCP endpoint. The interface uses readable monospace text, restrained phosphor color, a static scanline texture, clear focus states, and reduced-motion support.

This repository contains application code and fictional fixtures only. It does not contain a deployed instance, task data, backups, credentials, or a private deployment identity.

## Features

- Kanban states: To do, In progress, On hold, Canceled, Completed, Reference
- Category, next action, blocker, attention flag, source URL/chat reference, evidence note, and source-verification timestamp
- Date-only or explicitly timed tasks with IANA timezone; monthly recurrence preserves the local time and original day anchor through short months
- Optimistic revisions, idempotent mutation keys, durable change history, recoverable Trash
- Validated import preview, copy-only imports, portable JSON exports, and recovery snapshots
- Shared browser/API/MCP operations, with per-user record isolation
- Read-only paginated backups containing all tasks, bounded change history, and saved recovery snapshots

No external task ingestion, notifications, reminders, or automatic synchronization is included. The fictional examples are generated only when a user's board has no records.

## Local setup

Requires Node.js 24 and npm. The committed lockfile pins dependencies.

1. Run `npm ci`
2. Run `npm run setup` to copy the safe example into the ignored local configuration
3. Run `npm run build` to generate the local Worker configuration
4. Apply each SQL file in `drizzle/` once, in order, with:
   `node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file <migration.sql>`
5. Run `npm run dev` and open the URL printed by the server

The development-only local sign-in helper uses a fictional test identity and accepts loopback requests only. Mock sign-in is not included in production builds. Do not enable it on a public development server.

Commands:

- `npm test`: focused task service, recurrence, recovery, isolation, idempotency and backup tests
- `npm run typecheck`: TypeScript checks
- `npm run build`: Cloudflare-compatible Worker build
- `npm start`: run the built Worker locally
- `npm run db:generate`: generate migrations after changing the schema

The built-Worker integration checks in `tests/http.test.mjs` and `tests/persistence.test.mjs` use synthetic local identities. Run them only against loopback test servers, never a deployed instance.

## Authentication is a required trust boundary

The application is designed to run behind the Sites authenticated proxy. It trusts the proxy-supplied `oai-authenticated-user-id` and verified-email headers, scopes every data query by that user ID, and rejects missing identity. Browser sign-in routes are owned by that platform.

DO NOT expose this Worker directly to the public Internet while trusting arbitrary client-supplied identity headers. For another hosting provider, implement real authentication at a trusted edge that strips and unconditionally replaces incoming identity headers, or replace the authentication helpers with verified sessions. Public source code does not imply a public task database.

Keep the hosted application's access policy private unless its owner explicitly chooses otherwise. Service-access credentials do not substitute for user identity. MCP discovery contains schemas only; task-data tools require an authenticated user.

## Remote MCP

Stateless JSON-RPC over `POST /mcp` supports initialization, discovery, and these tools:

- `list_tasks`, `get_task`
- `create_task`, `update_task`, `complete_task`
- `archive_task`, `restore_task`
- `export_tasks`, `export_backup_page`
- `preview_import`, `import_tasks`, `list_snapshots`, `get_snapshot`

Mutation tools require an idempotency request key. Updates also require the current task revision. Reuse the same key and exact arguments only when retrying an uncertain mutation. Treat task titles, notes, and source links as untrusted user content.

## Import and recovery

The version-1 portable format uses `format: "task-board-pilot"`, `version: 1`, an ISO `exportedAt`, a `tasks` array, and a `history` array. Preview returns a digest and counts; import requires that digest and a stable request key. Imports always create new task IDs and revisions, leave existing tasks unchanged, and retain the input file's original metadata/history in a source snapshot. A snapshot of the existing board is captured before import.

The current interactive pilot supports 100 task records including Trash, up to 2,000 history events in its portable import/export file, and a 1.5 MB request limit. Limit errors are explicit, not silent truncation. There is no permanent-deletion operation. Snapshot copy import is not full point-in-time recovery.

## Complete backups

`export_backup_page({})` starts a read-only capture. Save the returned manifest page, including its tasks and expected counts. Follow `nextCursor` with the same tool until a page returns `complete: true` and `nextCursor: null`. `pageSize` accepts 1–100 and defaults to 20. Keep every page's `backupId` and `capturedAt` consistent. Verify total task, history, and snapshot counts against the manifest before marking a backup complete.

The manifest's tasks and history/snapshot high-water marks are read atomically. Subsequent pages include all history and snapshots through that boundary, excluding later writes. The paginated backup does not have the portable export's 2,000-event cap. Store the original pages to retain record metadata, history, idempotency receipts, and recovery snapshots. Complete paginated backups are an archival/recovery source; very large histories cannot be re-imported through the bounded interactive import form without a purpose-built restore process.

Backups contain private data. Keep them outside this repository, restrict filesystem access, never commit them, and monitor available storage. Retention scheduling and storage management belong to the deployment operator; this app does not create a backup schedule or silently remove backups.

## Deployment configuration

`.openai/hosting.example.json` declares only logical bindings and the MCP capability. Actual project IDs, runtime values, access policies, credentials, database state, exports and snapshots must remain private. The generated `.openai/hosting.json` is ignored. The local all-zero database ID is a placeholder and must not be used as a production database identity.

Migrations are schema-only, versioned source. Runtime data is stored by the platform and is not part of source control. Never modify already-applied migrations; append new ones.

## License

Application code is MIT licensed. Preserve the MIT notices for the vendored Sites Vite integration and shadcn CSS. Dependencies retain their own licenses.
