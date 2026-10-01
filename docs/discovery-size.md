# Discovery footprint

The lean-description update preserves the original 19 tool names, argument shapes and behavior. For the compact JSON `tools/list` result (`{"tools":[...]}`), excluding the JSON-RPC envelope:

| Measure | Before | After | Reduction |
|---|---:|---:|---:|
| UTF-8 bytes | 13,105 | 11,132 | 15.1% |
| `o200k_base` tokens | 2,911 | 2,528 | 13.2% |
| Tool-description UTF-8 bytes | 2,712 | 1,332 | 50.9% |

The separate v3 `export_migration_page` tool brings current discovery to 20 tools, 11,635 UTF-8 bytes and 1,492 tool-description bytes. It captures authoritative owner and upload retry metadata only while writes are explicitly frozen. The original v2 complete-backup contract remains unchanged. Token counts for this extension have not been measured.

Token counts were measured with the tiktoken `o200k_base` encoding, not inferred from character counts. Other models/client wrappers tokenize differently. These are discovery-size measurements, not measured latency improvements. The one-time initialization response includes a short shared privacy/retry instruction. Detailed instructions are opt-in documentation, not a new advertised MCP resource capability.

Reproduce current byte counts from the source checkout:

```
node --experimental-transform-types --import ./tests/loader.mjs scripts/measure-mcp.mjs
```

`tests/mcp-metadata.test.mjs` guards the compact byte budget and the revision, idempotency, privacy, backup and import cues. Schemas remain explicit; they were not replaced by client-dependent `$ref` compression.
