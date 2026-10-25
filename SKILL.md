---
name: flaredump
description: Capture and replay Cloudflare Worker crashes offline from .cfreplay.json.
---

# flaredump

Wrap your Worker export with `withFlareDump` to write a sanitized `.cfreplay.json` when a request throws or returns HTTP 5xx.

```bash
npx flaredump replay ./crash.cfreplay.json
npx flaredump --explain ./crash.cfreplay.json --model ollama/qwen2.5-coder:7b
npx flaredump --mcp
```

MCP tools: `inspect_cf_crash`, `replay_cf_crash`, `export_vitest_regression` (requires `--allow-write` unless `--dry-run`).
