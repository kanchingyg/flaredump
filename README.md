# flaredump

[![ci](https://github.com/kanchingyg/flaredump/actions/workflows/ci.yml/badge.svg)](https://github.com/kanchingyg/flaredump/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/flaredump)](https://www.npmjs.com/package/flaredump)
[![JSR](https://jsr.io/badges/@kanchingyg/flaredump)](https://jsr.io/@kanchingyg/flaredump)
[![Bun](https://img.shields.io/badge/runtime-Node_%7C_Bun-f9f1e1)](https://github.com/kanchingyg/flaredump)
[![license](https://img.shields.io/github/license/kanchingyg/flaredump)](https://github.com/kanchingyg/flaredump/blob/HEAD/LICENSE)

Flight recorder for Cloudflare Workers: capture failed requests (D1, KV, R2, and Workers AI reads) into `.cfreplay.json` and replay them offline in milliseconds.

## Install

[Bun](https://bun.sh) / [npm](https://www.npmjs.com/package/flaredump):

```bash
bunx flaredump replay ./crash.cfreplay.json
npx flaredump replay ./crash.cfreplay.json

# or install in your project / globally
bun add -d flaredump
npm i -D flaredump
```

[JSR](https://jsr.io/@kanchingyg/flaredump):

```bash
bunx jsr add @kanchingyg/flaredump
npx jsr add @kanchingyg/flaredump
```

## Quick start

```bash
npx flaredump replay ./crash.cfreplay.json
bunx flaredump replay ./crash.cfreplay.json
npx flaredump --explain ./crash.cfreplay.json --model ollama/qwen2.5-coder:7b
npx flaredump --mcp
```

## Worker middleware

```ts
import { withFlareDump } from "flaredump";

export default withFlareDump(async (request, env) => {
  const rows = await env.DB.prepare("SELECT 1").all();
  return Response.json(rows);
});
```

On throw or `status >= 500`, `flaredump` serializes the request plus binding results (secrets redacted as `[REDACTED]`).

## MCP (Cursor, Claude Code, Kilo Code, Pi)

Add to your MCP config:

```json
{
  "mcpServers": {
    "flaredump": {
      "command": "npx",
      "args": ["-y", "flaredump", "--mcp"]
    }
  }
}
```

| Tool | Purpose |
| --- | --- |
| `inspect_cf_crash` | Request, stack, D1/KV trace (context-truncated for local models) |
| `replay_cf_crash` | Re-run handler with deterministic mocked bindings |
| `export_vitest_regression` | Emit a Vitest regression test (`--allow-write` or `--dry-run`) |

## Local models (Ollama / LM Studio)

Use `--explain` with any OpenAI-compatible or Ollama endpoint to summarize a capture:

```bash
npx flaredump --explain crash.cfreplay.json --model ollama/qwen2.5-coder:7b
```

## License

[MIT](./LICENSE)
