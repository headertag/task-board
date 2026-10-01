# Connect an agent to Yet Another Task Board

## Start here

This application exposes a remote MCP endpoint at `https://task-board.example.com/mcp`. That URL is a placeholder. Get the exact endpoint and approved registration details from the deployment owner over a private channel.

The current server implements stateless JSON-RPC over HTTP POST and advertises MCP protocol version **2025-03-26**. It supports `initialize`, `notifications/initialized`, `ping`, `tools/list` and `tools/call`. GET returns 405; there is no SSE stream or session ID. It is not an implementation of the newer `server/discover` lifecycle, and it is not an A2A agent.

## Controlled Worker deployments

WorkOS AuthKit + Connect is the authorization server; the board is the protected resource. The board requires authentication before every MCP method, including initialization, ping and tool discovery. An unauthenticated request returns 401 with `WWW-Authenticate`; an authenticated GET returns 405 because this transport accepts POST. Successful discovery alone does not establish client compatibility. ALICE's actual browser OAuth and task-read flow remains unverified; complete the synthetic gate before claiming that connection works or using real tasks.

The deployment owner must first complete [the hosting setup](oauth-hosting.md), including the exact resource indicator, social providers, private identity-to-owner mapping, and one registration mode that the client supports. Use these connection steps only within that approved deployment:

1. Work within the owner's authorization for this board and operation scope.
2. Configure the exact private owner-provided `/mcp` URL.
3. Follow the challenge's `resource_metadata` URL. Its `resource` is the exact audience to request, and `authorization_servers` identifies the authoritative issuer. Discover the issuer's actual authorization and token endpoints. The board also relays validated authorization-server and OIDC metadata for clients that use those discovery paths.
4. Use either the owner's approved Public PKCE client ID with its exact registered callback, or client-supported CIMD/DCR that the owner has explicitly enabled. The app does not register clients, enable registration or supply fallback credentials. Use authorization code flow with a fresh state and an S256 challenge; public clients exchange the code with the same callback and matching `code_verifier`, without a client secret.
5. Request `openid profile email` and send the exact metadata `resource` on **both the authorization request and token exchange**. Do not substitute a host-only URL or environment client ID. Let the owner complete Google/GitHub sign-in and review the external application's consent in the provider's browser flow.
6. Let the OAuth client retain its token privately and send it as `Authorization: Bearer …` on every MCP request. Never paste tokens, codes, API keys or browser cookies into chat, public client configuration or repository files. Initialize, call `tools/list`, then use `list_tasks`/`get_task` to check the synthetic gate's exact expected record IDs. Agent access defaults to read-only; write tools are omitted and mutation calls rejected even if manually requested.
7. Complete the [synthetic verification gate](oauth-cutover.md) before real migration, then use only the approved operations described in [the contract](agent-operations.md).

The board cryptographically verifies the access token's signature, configured issuer, exact resource audience and expiry, then retrieves the authoritative WorkOS user and linked provider identities. It re-evaluates the private allowlist and explicit storage-owner mapping on every request, including API and image access. Google email selectors require a verified email and linked Google identity; GitHub selectors require the immutable provider ID. Successful signup or consent cannot admit an unlisted identity. Caller-supplied identity headers are ignored.

Agents acting under the same mapped owner access that owner's board only. Agent names, actor labels, assignment fields, source references and tool annotations grant no rights. Standard OIDC scopes also grant no task mutations. Writes need an explicitly approved client ID, a custom non-OIDC scope actually assigned by WorkOS and granted in the signed token, and an unlocked board. DCR/CIMD clients cannot receive per-client custom scopes; keep them read-only unless a separately approved, verified provider configuration supports the intended grant. See [the operation contract](agent-operations.md).

The previous private Sites deployment stays authoritative until cutover. Its provisioned platform authentication is a separate deployment contract; this source revision no longer accepts its proxy identity headers. Do not deploy this branch there or switch its production traffic without the migration approval and rollback plan.

## Machine-readable metadata

- [`server.example.json`](../server.example.json) is a **nonfunctional template** using the official MCP Registry server schema. Its `example.com` URL must be replaced with a deployment URL before use. Adjust the namespace/version to the deployment owner's actual identity and release. Schema validity does not prove reachability, authentication compatibility or registry ownership. Do not publish the template to a registry
- [`llms.txt`](../llms.txt) is an opt-in documentation index following the llms.txt convention. It is not an MCP protocol requirement, an authorization grant or an automatic agent installer
- `tools/list` is the authoritative runtime tool schema. Long operation and recovery instructions live in linked documentation rather than every discovery response

Keep private deployment URLs, OAuth configuration, task data, tokens and backups out of public metadata. No credentials or access are created by these files.

## Primary references

- [MCP 2025-03-26 lifecycle](https://modelcontextprotocol.io/specification/2025-03-26/basic/lifecycle)
- [MCP 2025-03-26 HTTP transport](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports)
- [MCP 2025-03-26 authorization](https://modelcontextprotocol.io/specification/2025-03-26/basic/authorization)
- [Current MCP authorization guidance](https://modelcontextprotocol.io/specification/latest/basic/authorization), for client compatibility research; it does not change this server's advertised revision
- [WorkOS MCP discovery and registration](https://workos.com/docs/authkit/mcp)
- [WorkOS Public PKCE applications](https://workos.com/docs/authkit/connect/oauth)
- [WorkOS Connect scopes and claims](https://workos.com/docs/authkit/connect/token-claims)
- [Official registry remote-server example](https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/server-json/generic-server-json.md#remote-server-example)
- [Pinned registry schema](https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json)
- [llms.txt proposal](https://llmstxt.org/)
