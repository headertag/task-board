# Connect an agent to Yet Another Task Board

## Start here

This application exposes a remote MCP endpoint at `https://YOUR_DEPLOYMENT_HOST/mcp`. The repository does **not** provide a live public server. Get the real endpoint from the deployment owner over a private channel.

The current server implements stateless JSON-RPC over HTTP POST and advertises MCP protocol version **2025-03-26**. It supports `initialize`, `notifications/initialized`, `ping`, `tools/list` and `tools/call`. GET returns 405; there is no SSE stream or session ID. It is not an implementation of the newer `server/discover` lifecycle, and it is not an A2A agent.

## Sites-hosted deployments

Sites manages authentication and its provisioned plugin. For ChatGPT/Codex, use the deployment's existing plugin through the platform's installation/connection UI. Do not create another plugin or run local `codex mcp add` / `codex mcp login` commands for this route.

For another agent client, remote HTTP and OAuth support are necessary capabilities, but **compatibility with a particular private Sites deployment is unverified until the complete flow succeeds**. Generic OAuth 2 support alone does not establish MCP interoperability. The application does not supply a client ID, client secret, authorization server, token endpoint, scopes or registration endpoint. Do not guess them.

1. Work within the owner's authorized request or standing workflow for this particular agent, board and operation scope
2. Configure a remote/Streamable HTTP MCP server with the exact owner-provided `/mcp` URL
3. Let the client follow the deployment's supported authentication discovery. If its OAuth flow requires registration details it cannot obtain, stop and ask the owner/platform administrator for the supported route
4. Let the owner review and complete consent. Never copy browser cookies, use service-bypass credentials, or manufacture trusted identity headers
5. Negotiate the supported protocol revision, initialize and call `tools/list`
6. Make one read-only `list_tasks` call as a connection test. Keep the result private. Do not create a test task unless requested
7. Enable only the tools needed for the approved job, then follow [the operation contract](agent-operations.md)

A client must handle the deployment's actual authorization discovery, registration and consent behavior, including any resource/audience and PKCE requirements. These are compatibility checks, not claims that this source implements an authorization server. If blocked, record the HTTP status and a redacted error; do not weaken the Site's access policy or retry using another identity.

Owner-authorized agents acting under the same authenticated owner can operate that owner's board. Another person or an agent label does not inherit access. Actor labels, assignment fields and source references are data, not authorization identities.

## Other hosting providers

First implement real authentication. The source trusts identity headers supplied by the Sites authenticated proxy. A public Worker accepting those headers directly would be unsafe. Use an authenticated edge that strips and unconditionally replaces incoming identity headers, or replace the helper with verified sessions. Keep database and object authorization owner-scoped. See the [README trust-boundary warning](../README.md#authentication-is-a-required-trust-boundary).

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
