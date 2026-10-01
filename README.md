# Yet Another Task Board

A small full-stack task board with an amber CRT-inspired interface, durable Cloudflare D1 storage, and a stateless remote MCP endpoint. The interface uses warm brown-black panels, orange controls, readable ivory content, clear focus states, and reduced-motion support.

This repository contains application code and fictional fixtures only. It does not contain a deployed instance, task data, backups, credentials, or a private deployment identity.

## Features

- Kanban states: To do, In progress, On hold, Canceled, Completed, Reference
- Category, next action, blocker, attention flag, source URL/chat reference, evidence note, and source-verification timestamp
- Date-only or explicitly timed tasks with IANA timezone; monthly recurrence preserves the local time and original day anchor through short months
- Optimistic revisions, idempotent mutation keys, durable change history, recoverable Trash
- Validated import preview, copy-only imports, portable JSON exports, and recovery snapshots
- Shared browser/API/MCP operations, with per-user record isolation
- Spacious read-first task details with separate editing and unsaved-draft protection
- Safe clickable source links, product cards and address/map cards without external preview fetching
- Durable comments with independent revisions, recoverable removal, private normalized image attachments
- Checksummed complete backups containing tasks, all history, comments, private images and recovery snapshots

No external task ingestion, notifications, reminders, or automatic synchronization is included. The fictional examples are generated only when a user's board has no records.

## Local setup

Requires Node.js 24 and npm. The committed lockfile pins dependencies.

1. Run `npm ci`
2. Run `npm run setup` to copy the safe example into the ignored local configuration
3. Run `npm run build` to generate the local Worker configuration
4. Apply each SQL file in `drizzle/` once, in order, with:
   `node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file <migration.sql>`
5. Run `npm run dev` and open the URL printed by the server

Authentication now fails closed without approved WorkOS configuration. The old local header-based sign-in helper is disabled. Use the no-network synthetic auth tests for development, or a separately authorized staging provider setup. See [controlled hosting](docs/oauth-hosting.md).

Commands:

- `npm test`: task service, UI, real-signature auth/route/discovery, private backup and exact recovery tests
- `npm run typecheck`: TypeScript checks
- `npm run build`: Cloudflare-compatible Worker build
- `npm start`: run the built Worker locally
- `npm run db:generate`: generate migrations after changing the schema

The no-network route tests exercise actual signed synthetic JWTs and browser PKCE with local SQLite/R2 substitutes. Additional built-Worker integration checks require privately supplied, explicitly authorized synthetic staging credentials and only allow loopback servers. Never run mutation tests against a real board.

## Authentication is a required trust boundary

Controlled Workers use cryptographically verified WorkOS AuthKit/Connect credentials and a private per-request Google/GitHub identity allowlist. Browser login uses Public PKCE and a sealed, expiring session; MCP/API bearer tokens require the exact configured issuer/audience/expiry and a user consent. Incoming identity headers confer no access. Explicit identity rules map to existing storage owners and every D1/R2 query remains owner-scoped.

External agents default to read-only. Client labels and OIDC scopes do not grant mutations. A custom write scope plus a privately approved client is required for agent writes. No account grant, social credentials, allowlist, paid service, deployment or migration is created by this source. Follow [controlled hosting](docs/oauth-hosting.md) and the [synthetic cutover gate](docs/oauth-cutover.md). The existing private Site remains authoritative until verified, authorized cutover.

## Remote MCP

Start with the [agent connection guide](docs/agent-setup.md) and [operation contract](docs/agent-operations.md). The [server descriptor template](server.example.json) and [llms.txt index](llms.txt) contain no live deployment URL or credentials. External-client OAuth interoperability must be verified for each deployment.

Stateless JSON-RPC over `POST /mcp` advertises protocol version `2025-03-26` and supports initialization, discovery, and these tools:

- `list_tasks`, `get_task`
- `create_task`, `update_task`, `complete_task`
- `archive_task`, `restore_task`
- `list_comments`, `get_comment`, `add_comment`, `edit_comment`, `archive_comment`, `restore_comment`
- `export_tasks`, `export_backup_page`
- `preview_import`, `import_tasks`, `list_snapshots`, `get_snapshot`

Mutation tools require an idempotency request key. Updates also require the current task or comment revision. Reuse the same key and exact arguments only when retrying an uncertain mutation. Treat task titles, notes, and source links as untrusted user content.

## Import, images and complete recovery

See [BACKUP-RECOVERY.md](BACKUP-RECOVERY.md) for the version-2 portable and complete formats, image limits, immutable history, cursor/checksum rules and an exact isolated recovery command. Portable version-1 files remain importable. New full backups use version 2 and include every private image byte. All source fixtures are fictional.

`npm test` includes adversarial image validation, owner isolation, idempotency, import retries, exact SQLite/object recovery, UI race handling, safe links and draft preservation. The additional built-Worker upload tests require explicitly supplied synthetic credentials and allow loopback targets only.

## Deployment configuration

`.openai/hosting.example.json` declares only logical bindings and the MCP capability. D1 `DB` stores records and R2 `IMAGES` stores private image bytes. Actual project IDs, runtime values, access policies, credentials, database state, exports and snapshots must remain private. The generated `.openai/hosting.json`, `.dev.vars`, and `wrangler.private.jsonc` are ignored. [wrangler.example.jsonc](wrangler.example.jsonc) retains the built adapter for approved user-owned Cloudflare staging. The local all-zero database ID is a placeholder and must not be used as a production database identity.

Migrations are schema-only, versioned source. Runtime data is stored by the platform and is not part of source control. Never modify already-applied migrations; append new ones.

## License

Application code is MIT licensed. Preserve the MIT notices for the vendored Sites Vite integration and shadcn CSS. Dependencies retain their own licenses.
