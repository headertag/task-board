# Operation parity

For new data features, browser and MCP transports call the same `execute` operation in `lib/operations.ts`. That registry is also the source of read/write permission classification and MCP discovery. Keep validation and business rules in shared server modules; never implement a browser-only data mutation. Both transports authenticate, enforce the same permission/freeze policy, and delegate to owner-scoped services. MCP annotations describe the registry; client-provided hints do not grant permission.

| Capability | Shared operations | Web behavior |
|---|---|---|
| Checklist item CRUD / check / uncheck / reorder | `edit_checklist`, validated in `lib/checklist.ts`, transactional `BoardService.mutate` | Immediate checkbox updates use item operation; draft bulk editing uses existing shared `update_task` |
| Whole checklist drafts | `create_task`, `update_task` | Save editor draft |
| Task and comment file uploads | `upload_attachment` | Original bytes for both task and comment file pickers; shared resumable multipart upload |
| Attachment metadata / bytes | `list_attachments`, `get_attachment`, `ActivityService.metadata/image` | Task attachments and authenticated binary download route |
| Comments and file associations | `add_comment`, `edit_comment`, `archive_comment`, `restore_comment` | Comment composer/history |

Image resize/canvas preparation is presentation-side input preparation, not authorization or persistence. Server normalization and file limits are always enforced. `/api/images` remains a compatibility binary adapter to the same upload/read services; it does not introduce a separate storage path. Generic files download with attachment disposition, nosniff and sandbox headers, never inline HTML.

Release checks cover both actual HTTP route handlers with authenticated browser and OAuth principals, discovery, exact retries across transports, revisions, ownership, read-only grants, global freeze, full backup/import recovery, and UI behavior. A new browser feature must ship with advertised MCP operations and these parity checks. Deployment success alone does not establish that an existing agent has refreshed a cached schema.

This is the checklist/upload slice of issue #18. Its broader audit of pre-existing access-administration, seed and recovery surfaces remains separate; this release does not expand agent administration privileges.

Original uploads preserve bytes and metadata. Both clients call `upload_attachment`: inline up to 5 MiB, or durable 5 MiB R2 multipart chunks up to 100 MiB. D1 reserves immutable file identity and part hashes before storage; only verified complete files become visible. Interrupted requests replay with the same key; paused sessions renew before R2 expiry. Inline raster previews sniff signatures and stream original bytes; other files remain private downloads. Complete backups use owner-scoped manifest references so cursor size stays bounded as attachment counts grow.
