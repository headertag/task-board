# Connect an agent to Yet Another Task Board

## Start here

This application exposes a remote MCP endpoint at `https://YOUR_DEPLOYMENT_HOST/mcp`. The repository does **not** provide a live public server. Get the real endpoint from the deployment owner over a private channel.

The current server implements stateless JSON-RPC over HTTP POST and advertises MCP protocol version **2025-03-26**. It supports `initialize`, `notifications/initialized`, `ping`, `tools/list` and `tools/call`. GET returns 405; there is no SSE stream or session ID. It is not an implementation of the newer `server/discover` lifecycle, and it is not an A2A agent.

## Controlled Worker deployments

WorkOS AuthKit + Connect supplies standard authorization-server discovery, Public PKCE, and an approved registration mode. The board supplies protected-resource metadata and requires authentication before every MCP method, including initialization and tool discovery. An unauthenticated GET returns 401 with `WWW-Authenticate`; an authenticated GET returns 405. Follow [the hosting setup](oauth-hosting.md) rather than guessing issuer/client details.

1. Work within the owner's authorization for this board and operation scope.
2. Configure the exact private owner-provided `/mcp` URL.
3. Follow `WWW-Authenticate` to protected-resource metadata, then the actual issuer's authorization-server/OIDC metadata. Request the advertised minimal OIDC scopes and exact `resource`. Use S256 PKCE.
4. Use the owner's approved CIMD, DCR or Public PKCE preregistration mode and privately supplied exact callback. The app does not create clients or claim DCR is enabled automatically.
5. Let the owner sign in with the allowed Google/GitHub identity and review third-party consent. Never copy browser cookies, manufacture identity headers, or reuse service credentials.
6. Initialize and call `tools/list`, then read the synthetic gate's exact expected task IDs. Default agent permissions are read-only; write tools are omitted and mutation calls rejected even if manually requested.
7. Complete the [synthetic verification gate](oauth-cutover.md) before real migration, then use only the approved operations described in [the contract](agent-operations.md).

Unlisted identities are rejected per request, even after successful provider signup. Agents acting under the same mapped owner access that owner's board only. Another owner and an agent label inherit no rights. Actor labels, assignment fields and source references are task data.

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
- [Official registry remote-server example](https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/server-json/generic-server-json.md#remote-server-example)
- [Pinned registry schema](https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json)
- [llms.txt proposal](https://llmstxt.org/)
