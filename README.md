# flaredump

[![ci](https://github.com/kanchingyg/flaredump/actions/workflows/ci.yml/badge.svg)](https://github.com/kanchingyg/flaredump/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/flaredump/latest?label=npm)](https://www.npmjs.com/package/flaredump)
[![JSR](https://jsr.io/badges/@kanchingyg/flaredump)](https://jsr.io/@kanchingyg/flaredump)
[![JSR Score](https://jsr.io/badges/@kanchingyg/flaredump/score)](https://jsr.io/@kanchingyg/flaredump/score)
[![Runtime](https://img.shields.io/badge/runtime-Node_%7C_Bun_%7C_Deno-f9f1e1)](https://github.com/kanchingyg/flaredump)
[![license](https://img.shields.io/github/license/kanchingyg/flaredump)](https://github.com/kanchingyg/flaredump/blob/HEAD/LICENSE)
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

## MCP Tools Reference

| Tool | Mutates | Description |
| --- | --- | --- |
| `inspect_cf_crash` | `false` | Read a `.cfreplay.json` crash file and return request metadata, error stack, and D1/KV/R2 binding traces truncated to the model context budget. |
| `replay_cf_crash` | `false` | Re-execute the Worker handler offline against deterministic mocked bindings captured in `.cfreplay.json`. |
| `export_vitest_regression` | `true` | Generate and write a Vitest regression test reproducing the captured crash (requires `--allow-write`). |

## Editor and Agent Integration

### Cursor (`.cursor/mcp.json`)

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

### Claude Code CLI

```bash
claude mcp add flaredump -- npx -y flaredump --mcp
```

### Programmatic Usage (JSR / TypeScript)

```ts
import * as bridge from "jsr:@kanchingyg/flaredump/bridge";
```

## Runtime Safety and Guardrails

- **Stdio frame isolation**: When `--mcp` is active, `hijackStdoutForMcp()` redirects accidental `console.log` calls to `stderr` so JSON-RPC 2.0 frames on `stdout` never corrupt.
- **Read-only by default**: Mutating tools (`mutates: true`) are blocked in `--dry-run` mode and require explicit `--allow-write` authorization.
- **Loop breaker**: Repeated identical `(toolName, args)` invocations are hashed with SHA-256 and halted after 3 consecutive repeats to prevent runaway agent loops.
- **Context budget truncation**: Tool outputs are middle-truncated (`60%` head / `40%` tail) scaled to the probed local model `n_ctx` (Ollama `/api/show`, llama.cpp `/props`, vLLM `/v1/models`).
- **Secret redaction and path normalization**: AWS keys (`AKIA*`, `ASIA*`), bearer tokens, and `sk-*` keys are scrubbed before returning tool output, and Windows drive paths (`C:\...`) translate cleanly to `/mnt/c/...` when WSL mode is enabled.

## License

[MIT](./LICENSE)
