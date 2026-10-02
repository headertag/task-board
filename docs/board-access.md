# Board access

The owner can maintain a list of exact Google email addresses from the board itself. These addresses share the existing board, including tasks, Trash, comments, images and exports. No invitation email is sent. Share the board URL separately when appropriate.

## Add someone manually

1. Sign in as the configured board owner and click **Access** in the top bar.
2. Enter the person's exact Google email address, choose **Can view** or **Can view and edit**, and click **Add address**.
3. The person opens the same board URL and signs in with that Google account. The entry changes from **Awaiting first Google sign-in** to **Google account verified** after successful verification.

**Can view** permits reading and exporting board content. **Can view and edit** also permits task, checklist, comment, image and import mutations. Existing consented MCP access follows this role and the owner's agent delegation; explicit client restrictions and the global write freeze still apply. Allowing an address does not create a new OAuth client or consent a client on that person's behalf.

Use **Change access** to choose a different role and save it. **Revoke** blocks subsequent authenticated requests, even with an existing browser session or valid MCP token. An already authorized in-flight request may finish. **Allow again** restores the saved role and retains the verified identity pins. The list retains revoked entries and supports up to 1,000 total entries per board.

## Verification and administration

Addresses are trimmed and lowercased, without Gmail dot or plus alias substitution. WorkOS must report a verified exact email and exactly one linked Google OAuth identity. The first eligible sign-in atomically binds both immutable Google provider ID and WorkOS user ID. A replacement identity with the same email is refused. Changing, revoking or reallowing an entry never resets its pins. Resolve genuine account replacement through separately reviewed private administration.

Only browser sessions matching a fully pinned static Google owner identity can manage access. Invited collaborators and all MCP clients cannot call the management API. The owner's bootstrap policy stays in private deployment configuration and cannot be changed or removed through this screen. Successful Google authentication alone never grants an unlisted address access. Ambiguous owner mappings fail closed.

The protected, same-origin `/api/access` route returns safe email/role/active/bound summaries. POST accepts either `{action:"allow", email, access:"read"|"write"}` or `{action:"revoke", email}`. The server determines the storage owner and actor from the authenticated session; callers cannot supply identity pins or owner IDs. Access changes and first bindings append attributed private audit events. The additive schema migration creates `access_grants` and `access_events`; it does not rewrite task data.

## Recovery

Membership is security configuration and is excluded from task exports and complete v2/v3 backups. A fresh task recovery denies collaborators until the configured owner recreates the access list. Recover grants, pins and audit events separately through an authorized private database procedure if continuity is required. Keep them out of public source control. A Worker rollback leaves these additive tables intact; a version without this feature denies dynamic collaborators while preserving the owner's static policy.
