import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { withFlareDump, serializeReplay, type CfReplayFile } from "../src/recorder-middleware.js";
import { REDACTED, scrubDeep } from "../src/scrubber.js";
import {
  replayCfCrash,
  inspectCfCrash,
  exportVitestRegression,
  headTailTruncate,
  setReplayRoot,
  loadReplayFile,
  safeReplayRequestUrl,
} from "../src/replayer.js";
import {
  hijackStdoutForMcp,
  jsonRpcFrameLog,
  dispatchMcpMessage,
  setGuards,
  resetLoopBreaker,
  checkLoopBreaker,
  guardMutatingTool,
  windowsToWsl,
  wslToWindows,
  normalizeEmbedBatch,
  floatArrayToBase64,
  base64ToFloatArray,
  mrlSlice,
  assertDimensionFingerprint,
  readEmbedLock,
  writeEmbedLock,
  EMBED_LOCK,
  parseDirtyToolCall,
  StreamToolJsonAbort,
  applyReasoningContentPolicy,
  createReasoningState,
  sanitizeRequestBody,
  normalizeToolChoice,
  detectProvider,
  buildRecencyAnchor,
  anchorPromptTail,
  registerReplayHandler,
  FLAREDUMP_TOOLS,
  explainCrashWithModel,
} from "../src/bridge.js";

function makeEnv() {
  return {
    DB: {
      prepare: (sql: string) => ({
        bind: (...params: unknown[]) => ({
          all: async () => ({ results: [{ id: params[0] }] }),
        }),
      }),
    },
  };
}

beforeEach(() => {
  setReplayRoot(process.cwd());
});

describe("withFlareDump capture", () => {
  it("records D1 reads and redacts secrets on 500", async () => {
    let captured: CfReplayFile | undefined;
    const handler = withFlareDump(
      async (_req, env) => {
        await (env.DB as { prepare: (s: string) => { bind: (...p: unknown[]) => { all: () => Promise<unknown> } } })
          .prepare("SELECT * FROM users WHERE id = ?")
          .bind("secret-user")
          .all();
        throw new Error("boom");
      },
      { onCapture: (r) => (captured = r) },
    );

    const req = new Request("https://worker.example/api", {
      method: "POST",
      headers: { Authorization: "Bearer sk-testtoken1234567890abcdef" },
      body: '{"trigger":"fail"}',
    });

    await expect(handler(req, makeEnv())).rejects.toThrow("boom");
    expect(captured).toBeDefined();
    expect(captured!.bindings.some((b) => b.kind === "d1")).toBe(true);
    const serialized = serializeReplay(captured!);
    expect(serialized).toContain(REDACTED);
    expect(serialized).not.toContain("sk-testtoken");
  });

  it("replay reproduces the same crash offline", async () => {
    let captured: CfReplayFile | undefined;
    const inner = async (_req: Request, env: Record<string, unknown>) => {
      await (env.DB as ReturnType<typeof makeEnv>["DB"])
        .prepare("SELECT * FROM users WHERE id = ?")
        .bind("x")
        .all();
      throw new Error("boom");
    };
    const wrapped = withFlareDump(inner, { onCapture: (r) => (captured = r) });
    await expect(wrapped(new Request("https://x/"), makeEnv())).rejects.toThrow();

    const dir = mkdtempSync(join(tmpdir(), "flaredump-"));
    setReplayRoot(dir);
    const file = join(dir, "crash.cfreplay.json");
    writeFileSync(file, serializeReplay(captured!));

    const replay = await replayCfCrash(file, inner);
    expect(replay.threw).toBe(true);
    expect(replay.errorMessage).toBe("boom");
    rmSync(dir, { recursive: true });
  });
});

describe("MCP handshake", () => {
  beforeEach(() => {
    jsonRpcFrameLog.length = 0;
    resetLoopBreaker();
    setGuards({ allowWrite: false, dryRun: false });
  });

  it("initialize and tools/list", () => {
    dispatchMcpMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    dispatchMcpMessage({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const init = JSON.parse(jsonRpcFrameLog[0].trim());
    expect(init.result.serverInfo.name).toBe("flaredump");
    const list = JSON.parse(jsonRpcFrameLog[1].trim());
    expect(list.result.tools.length).toBe(FLAREDUMP_TOOLS.length);
  });
});

describe("MCP Blindaje 4", () => {
  let stderrChunks: string[];

  beforeEach(() => {
    stderrChunks = [];
    jsonRpcFrameLog.length = 0;
    const nativeStderr = process.stderr.write.bind(process.stderr);
    hijackStdoutForMcp();
    process.stderr.write = ((chunk: unknown, ...args: unknown[]) => {
      stderrChunks.push(String(chunk));
      return nativeStderr(chunk as Buffer, ...(args as [BufferEncoding?, (err?: Error) => void?]));
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stderr.write = process.stderr.write.bind(process.stderr);
  });

  it("routes noise to stderr", async () => {
    const tool = {
      name: "echo_path",
      description: "echo",
      inputSchema: { type: "object", properties: {}, additionalProperties: true },
    };
    dispatchMcpMessage(
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo_path", arguments: { path: "D:\\proj\\foo.ts" } } },
      {
        tools: [tool],
        pathToWsl: true,
        handlers: {
          echo_path: async (args) => {
            process.stdout.write("NOISE\n");
            return args;
          },
        },
      },
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(stderrChunks.join("")).toContain("NOISE");
    const last = JSON.parse(jsonRpcFrameLog[jsonRpcFrameLog.length - 1].trim());
    expect(last.result.content[0].text).toContain("/mnt/d/proj/foo.ts");
  });
});

describe("Blindaje 1", () => {
  beforeEach(() => {
    resetLoopBreaker();
    setGuards({ allowWrite: false, dryRun: false });
  });

  it("blocks mutating tools", () => {
    expect(
      guardMutatingTool({
        name: "x",
        description: "d",
        inputSchema: { type: "object", properties: {} },
        mutates: true,
      }).blocked,
    ).toBe(true);
  });

  it("loop breaker on third identical call", () => {
    expect(checkLoopBreaker("t", { a: 1 })).toBeNull();
    expect(checkLoopBreaker("t", { a: 1 })).toBeNull();
    expect(checkLoopBreaker("t", { a: 1 })).toMatch(/LOOP_BREAKER/);
  });
});

describe("Blindaje 2", () => {
  it("head+tail truncation", () => {
    const long = "H".repeat(200) + "T".repeat(200);
    const out = headTailTruncate(long, 200);
    expect(out).toContain("TRUNCATED");
    expect(out.startsWith("HHH")).toBe(true);
    expect(out.endsWith("TTT")).toBe(true);
  });

  it("recency anchor", () => {
    const anchor = buildRecencyAnchor([{ name: "inspect_cf_crash", summary: "Inspect capture" }]);
    const prompt = "SYSTEM\n...\nASSISTANT:";
    const anchored = anchorPromptTail(prompt, anchor);
    expect(anchored.indexOf(anchor)).toBeLessThan(anchored.lastIndexOf("ASSISTANT:"));
  });

  it("inspect truncates large replay payloads", () => {
    const dir = mkdtempSync(join(tmpdir(), "flaredump-inspect-"));
    setReplayRoot(dir);
    const file = join(dir, "big.cfreplay.json");
    const replay: CfReplayFile = {
      version: 1,
      capturedAt: new Date().toISOString(),
      request: { method: "GET", url: "https://x/", headers: {} },
      bindings: [{ kind: "d1", binding: "DB", op: "all", args: { sql: "x" }, result: { blob: "Z".repeat(8000) } }],
      error: { message: "fail" },
    };
    writeFileSync(file, JSON.stringify(replay));
    const inspected = inspectCfCrash(file, 512);
    expect(inspected.summary).toContain("TRUNCATED");
    rmSync(dir, { recursive: true });
  });
});

describe("Blindaje 5", () => {
  it("reasoning_content policy", () => {
    let state = createReasoningState();
    const msgs = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "ok", reasoning_content: "think", tool_calls: [{}] },
      { role: "tool", content: "{}" },
    ];
    const r1 = applyReasoningContentPolicy(msgs, state);
    expect(r1.messages[1].reasoning_content).toBe("think");
    state = r1.state;
    const r2 = applyReasoningContentPolicy(
      [...msgs, { role: "user", content: "next" }, { role: "assistant", content: "done", reasoning_content: "old" }],
      state,
    );
    expect(r2.messages[1].reasoning_content).toBeUndefined();
  });

  it("parses tool calls from messy model output", () => {
    const kimi =
      '<|tool_calls_section_begin|><｜tool▁call▁begin｜>functions.run:0<|tool_call_argument_begin|>{"target":"x"}<｜tool▁call▁end｜><|tool_calls_section_end|>';
    expect(parseDirtyToolCall(kimi)?.name).toBe("run");

    const glm =
      '<|tool_call_begin|>run_check<|tool_call_sep|>{"target":"a"}<|tool_call_end|>';
    expect(parseDirtyToolCall(glm)?.arguments.target).toBe("a");

    const qwen = "✿FUNCTION✿: run_check\n✿ARGS✿: {'target': 'z'}\n";
    expect(parseDirtyToolCall(qwen)?.name).toBe("run_check");

    const iq = "{'cmd': 'ls'}";
    expect(parseDirtyToolCall(iq)?.arguments).toEqual({ cmd: "ls" });
  });

  it("stream abort when tool JSON closes", () => {
    const guard = new StreamToolJsonAbort();
    expect(guard.feed('<tool_call>{"name":"t","arguments":{')).toBe(false);
    expect(guard.feed("}}")).toBe(true);
  });

  it("provider sanitization", () => {
    const body = sanitizeRequestBody({ temperature: 0.2, top_p: 0.9, model: "deepseek-reasoner" }, "deepseek-reasoner");
    expect(body.temperature).toBeUndefined();
    expect(normalizeToolChoice("required", detectProvider("https://dashscope.aliyuncs.com"))).toBe("auto");
  });
});

describe("Blindaje 3 embed", () => {
  it("splits batches of 60 into 6x10", async () => {
    const calls: number[] = [];
    const upstream = {
      name: "dashscope",
      maxBatch: 10,
      embed: async (input: string[]) => {
        calls.push(input.length);
        return input.map(() => [1, 0, 0]);
      },
    };
    await normalizeEmbedBatch(Array.from({ length: 60 }, (_, i) => `t-${i}`), {
      upstream,
      model: "text-embedding-v3",
      dimensions: 3,
    });
    expect(calls).toEqual([10, 10, 10, 10, 10, 10]);
  });

  it("float base64 and MRL", () => {
    const b64 = floatArrayToBase64([3, 4]);
    expect(base64ToFloatArray(b64)[0]).toBeCloseTo(3);
    const sliced = mrlSlice([3, 4, 0], 2);
    expect(Math.hypot(sliced[0], sliced[1])).toBeCloseTo(1);
  });

  it("dimension fingerprint", () => {
    expect(() => assertDimensionFingerprint({ provider: "x", model: "m", dimension: 1024 }, 768)).toThrow(
      /fingerprint/,
    );
    const dir = mkdtempSync(join(tmpdir(), "flaredump-embed-"));
    writeEmbedLock(dir, { provider: "p", model: "m", dimension: 1024 });
    expect(readEmbedLock(dir)?.dimension).toBe(1024);
    expect(existsSync(join(dir, EMBED_LOCK))).toBe(true);
    rmSync(dir, { recursive: true });
  });
});

describe("MCP tools integration", () => {
  it("inspect_cf_crash via dispatch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flaredump-mcp-"));
    setReplayRoot(dir);
    const file = join(dir, "crash.cfreplay.json");
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        capturedAt: new Date().toISOString(),
        request: { method: "GET", url: "https://x/", headers: {} },
        bindings: [],
        error: { message: "kaboom" },
      }),
    );
    jsonRpcFrameLog.length = 0;
    dispatchMcpMessage({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "inspect_cf_crash", arguments: { file } },
    });
    await new Promise((r) => setTimeout(r, 30));
    const frame = JSON.parse(jsonRpcFrameLog[jsonRpcFrameLog.length - 1].trim());
    expect(frame.result.content[0].text).toContain("kaboom");
    rmSync(dir, { recursive: true });
  });

  it("export_vitest_regression dry-run without allow-write", async () => {
    setGuards({ allowWrite: false, dryRun: true });
    const dir = mkdtempSync(join(tmpdir(), "flaredump-export-"));
    setReplayRoot(dir);
    const file = join(dir, "sample.cfreplay.json");
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        capturedAt: new Date().toISOString(),
        request: { method: "GET", url: "https://x/", headers: {} },
        bindings: [],
        error: { message: "e" },
      }),
    );
    jsonRpcFrameLog.length = 0;
    dispatchMcpMessage({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: { name: "export_vitest_regression", arguments: { file } },
    });
    await new Promise((r) => setTimeout(r, 30));
    const frame = JSON.parse(jsonRpcFrameLog[jsonRpcFrameLog.length - 1].trim());
    expect(frame.result.content[0].text).toContain("dryRun");
    rmSync(dir, { recursive: true });
  });
});

describe("Ollama explain adapter", () => {
  it("calls OpenAI-compat /api/chat", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ message: { content: "root cause: null deref" } }),
    })) as unknown as typeof fetch;

    const dir = mkdtempSync(join(tmpdir(), "flaredump-explain-"));
    setReplayRoot(dir);
    const file = join(dir, "e.cfreplay.json");
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        capturedAt: new Date().toISOString(),
        request: { method: "GET", url: "https://x/", headers: {} },
        bindings: [],
        error: { message: "fail" },
      }),
    );

    const text = await explainCrashWithModel(file, {
      model: "ollama/qwen2.5-coder:7b",
      baseUrl: "http://127.0.0.1:11434",
      fetchImpl,
    });
    expect(text).toContain("root cause");
    expect(fetchImpl).toHaveBeenCalled();
    rmSync(dir, { recursive: true });
  });
});

describe("path normalize", () => {
  it("windows and wsl", () => {
    expect(windowsToWsl("D:\\proj\\foo.ts")).toBe("/mnt/d/proj/foo.ts");
    expect(wslToWindows("/mnt/d/proj/foo.ts")).toBe("D:\\proj\\foo.ts");
  });
});

describe("exportVitestRegression", () => {
  it("generates vitest source", () => {
    const dir = mkdtempSync(join(tmpdir(), "flaredump-vitest-"));
    setReplayRoot(dir);
    const file = join(dir, "c.cfreplay.json");
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        capturedAt: new Date().toISOString(),
        request: { method: "GET", url: "https://x/", headers: {} },
        bindings: [],
        error: { message: "err" },
      }),
    );
    const src = exportVitestRegression(file);
    expect(src).toContain("replayCfCrash");
    expect(src).toContain("expect(result.threw).toBe(true)");
    rmSync(dir, { recursive: true });
  });
});

describe("scrubber", () => {
  it("redacts nested secrets", () => {
    const out = scrubDeep({ headers: { authorization: "Bearer abc" }, note: "sk-abcdefghijklmnopqrst" });
    expect(out.headers.authorization).toBe(REDACTED);
    expect(out.note).toBe(REDACTED);
  });
});

describe("replay path containment", () => {
  it("rejects path traversal in replay file paths", () => {
    expect(() => loadReplayFile("../../../etc/passwd")).toThrow(/traversal|escapes/i);
  });

  it("rejects files outside replay root", () => {
    const dir = mkdtempSync(join(tmpdir(), "flaredump-outside-"));
    const outside = join(dir, "outside.cfreplay.json");
    writeFileSync(
      outside,
      JSON.stringify({
        version: 1,
        capturedAt: new Date().toISOString(),
        request: { method: "GET", url: "https://x/", headers: {} },
        bindings: [],
      }),
    );
    expect(() => loadReplayFile(outside)).toThrow(/escapes replay root/i);
    rmSync(dir, { recursive: true });
  });
});

describe("passthrough env capture", () => {
  it("scrubs API_KEY passthrough bindings in cfreplay", async () => {
    let captured: CfReplayFile | undefined;
    const handler = withFlareDump(
      async () => {
        throw new Error("fail");
      },
      { onCapture: (r) => (captured = r) },
    );
    await expect(
      handler(new Request("https://x/"), { API_KEY: "sk-live-secret-value-abcdefghijklmnop", DB: makeEnv().DB }),
    ).rejects.toThrow();
    expect(captured?.passthroughEnv?.API_KEY).toBe(REDACTED);
    const serialized = serializeReplay(captured!);
    expect(serialized).not.toContain("sk-live-secret");
  });
});

describe("safe replay URL", () => {
  it("rewrites captured URL to replay.local by default", () => {
    expect(safeReplayRequestUrl("http://169.254.169.254/latest/meta-data")).toBe(
      "https://replay.local/latest/meta-data",
    );
  });

  it("dry-run still runs read-only inspect", async () => {
    setGuards({ allowWrite: false, dryRun: true });
    const dir = mkdtempSync(join(tmpdir(), "flaredump-dry-read-"));
    setReplayRoot(dir);
    const file = join(dir, "d.cfreplay.json");
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        capturedAt: new Date().toISOString(),
        request: { method: "GET", url: "https://x/", headers: {} },
        bindings: [],
        error: { message: "dry-inspect" },
      }),
    );
    jsonRpcFrameLog.length = 0;
    dispatchMcpMessage({
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: { name: "inspect_cf_crash", arguments: { file } },
    });
    await new Promise((r) => setTimeout(r, 30));
    const frame = JSON.parse(jsonRpcFrameLog[jsonRpcFrameLog.length - 1].trim());
    expect(frame.result.content[0].text).toContain("dry-inspect");
    rmSync(dir, { recursive: true });
  });
});

describe("replay_cf_crash MCP", () => {
  it("replays via registered handler", async () => {
    setGuards({ allowWrite: false, dryRun: false });
    registerReplayHandler("default", async () => {
      throw new Error("offline-boom");
    });
    const dir = mkdtempSync(join(tmpdir(), "flaredump-replay-mcp-"));
    setReplayRoot(dir);
    const file = join(dir, "r.cfreplay.json");
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        capturedAt: new Date().toISOString(),
        request: { method: "GET", url: "https://x/", headers: {} },
        bindings: [],
        error: { message: "offline-boom" },
      }),
    );
    jsonRpcFrameLog.length = 0;
    dispatchMcpMessage({
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: { name: "replay_cf_crash", arguments: { file, workerEntry: "default" } },
    });
    await new Promise((r) => setTimeout(r, 40));
    const frame = JSON.parse(jsonRpcFrameLog[jsonRpcFrameLog.length - 1].trim());
    expect(frame.result.content[0].text).toContain("offline-boom");
    rmSync(dir, { recursive: true });
  });
});
