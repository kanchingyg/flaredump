import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { resolvePathUnderRoot } from "./path-containment.js";
import {
  exportVitestRegression,
  inspectCfCrash,
  replayCfCrash,
  headTailTruncate,
  DEFAULT_N_CTX,
  type ReplayUrlOptions,
} from "./replayer.js";

export {
  headTailTruncate,
  DEFAULT_N_CTX,
  inspectCfCrash,
  replayCfCrash,
  exportVitestRegression,
};

export function buildRecencyAnchor(sigs: Array<{ name: string; summary: string }>): string {
  const lines = sigs.map((s) => `- ${s.name}: ${s.summary}`);
  return [
    "[AVAILABLE TOOLS — ANCHORED FOR RECENCY]",
    ...lines,
    'To call a tool, output ONLY: <tool_call>{"name": "TOOL_NAME", "arguments": {...}}</tool_call>',
  ].join("\n");
}

export function anchorPromptTail(prompt: string, anchor: string): string {
  const marker = "\nASSISTANT:";
  const idx = prompt.lastIndexOf(marker);
  if (idx === -1) return `${prompt}\n\n${anchor}\n${marker}`;
  return `${prompt.slice(0, idx)}\n\n${anchor}\n${prompt.slice(idx)}`;
}

export type GuardOptions = { allowWrite?: boolean; dryRun?: boolean };
let allowWrite = false;
let dryRun = false;

export function setGuards(opts: GuardOptions): void {
  allowWrite = Boolean(opts.allowWrite);
  dryRun = Boolean(opts.dryRun);
}

export function canonicalizeJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalizeJson(v)).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalizeJson(obj[k])}`).join(",")}}`;
}

const loopState = { lastHash: "", repeatCount: 0 };
export function resetLoopBreaker(): void {
  loopState.lastHash = "";
  loopState.repeatCount = 0;
}

export function checkLoopBreaker(toolName: string, args: unknown): string | null {
  const h = createHash("sha256")
    .update(`${toolName}:${canonicalizeJson(args)}`)
    .digest("hex");
  if (h === loopState.lastHash) loopState.repeatCount++;
  else {
    loopState.lastHash = h;
    loopState.repeatCount = 1;
  }
  if (loopState.repeatCount >= 3) {
    return "LOOP_BREAKER: Identical tool call repeated 2 times consecutively. Stop calling tools and return your final synthesis.";
  }
  return null;
}

export type McpToolDef = {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  mutates?: boolean;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
  };
};

export function guardMutatingTool(tool: McpToolDef): { blocked: boolean; reason?: string } {
  if (!tool.mutates) return { blocked: false };
  if (dryRun) return { blocked: false };
  if (!allowWrite) {
    return { blocked: true, reason: "Read-only mode: pass --allow-write to enable mutating tools." };
  }
  return { blocked: false };
}

const WIN_DRIVE_RE = /^([A-Za-z]):\\(.*)$/;
const WSL_RE = /^\/mnt\/([a-z])\/(.*)$/i;

export function windowsToWsl(p: string): string {
  const m = p.match(WIN_DRIVE_RE);
  if (!m) return p;
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, "/")}`;
}

export function wslToWindows(p: string): string {
  const m = p.match(WSL_RE);
  if (!m) return p;
  return `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, "\\")}`;
}

export function normalizePathsDeep<T>(value: T, toWsl: boolean): T {
  if (typeof value === "string") {
    if (toWsl && WIN_DRIVE_RE.test(value)) return windowsToWsl(value) as T;
    if (!toWsl && WSL_RE.test(value)) return wslToWindows(value) as T;
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => normalizePathsDeep(v, toWsl)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = normalizePathsDeep(v, toWsl);
    }
    return out as T;
  }
  return value;
}

export function toolOutputBudgetChars(nCtx: number, charsPerToken = 4): number {
  return Math.floor(nCtx * charsPerToken * 0.3);
}

export function truncateToolOutput(text: string, nCtx: number): string {
  return headTailTruncate(text, toolOutputBudgetChars(nCtx));
}

export function redactSecrets(text: string): string {
  return String(text)
    .replace(/(api[_-]?key|token|password|secret)\s*[=:]\s*[^\s]+/gi, "$1=[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
    .replace(/sk-[A-Za-z0-9]{20,}/g, "[REDACTED]");
}

export function finalizeMcpToolText(
  text: string,
  opts?: { nCtx?: number; toWsl?: boolean },
): string {
  const nCtx = opts?.nCtx ?? DEFAULT_N_CTX;
  const toWsl = opts?.toWsl ?? false;
  return normalizePathsDeep(
    redactSecrets(truncateToolOutput(String(text), nCtx)),
    !toWsl,
  );
}

let jsonRpcWrite: ((line: string) => void) | null = null;
let stdoutHijacked = false;
export const jsonRpcFrameLog: string[] = [];

export function hijackStdoutForMcp(): void {
  if (stdoutHijacked) return;
  stdoutHijacked = true;
  const native = process.stdout.write.bind(process.stdout);
  jsonRpcWrite = (line: string) => native(line);
  process.stdout.write = ((chunk: unknown, ...args: unknown[]) => {
    const str = typeof chunk === "string" ? chunk : Buffer.from(chunk as Buffer).toString();
    if (jsonRpcWrite && str.trim().startsWith("{") && str.includes('"jsonrpc"')) {
      return native(chunk as string, ...(args as []));
    }
    process.stderr.write(str);
    return true;
  }) as typeof process.stdout.write;
}

export function writeJsonRpcFrame(obj: object): void {
  const line = JSON.stringify(obj) + "\n";
  jsonRpcFrameLog.push(line);
  if (jsonRpcWrite) jsonRpcWrite(line);
  else process.stdout.write(line);
}

export const FLAREDUMP_TOOLS: McpToolDef[] = [
  {
    name: "inspect_cf_crash",
    description: "Inspect a .cfreplay.json crash capture.",
    inputSchema: {
      type: "object",
      properties: { file: { type: "string" } },
      required: ["file"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "replay_cf_crash",
    description: "Replay a crash offline with mocked bindings.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string" },
        workerEntry: { type: "string" },
      },
      required: ["file"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "export_vitest_regression",
    description: "Emit a Vitest regression from a replay file.",
    inputSchema: {
      type: "object",
      properties: { file: { type: "string" }, testName: { type: "string" } },
      required: ["file"],
      additionalProperties: false,
    },
    mutates: true,
    annotations: { destructiveHint: true },
  },
];

const handlerRegistry = new Map<string, import("./recorder-middleware.js").WorkerHandler>();

export function registerReplayHandler(name: string, handler: import("./recorder-middleware.js").WorkerHandler): void {
  handlerRegistry.set(name, handler);
}

export function createFlareDumpHandlers(): Record<string, (args: Record<string, unknown>) => Promise<unknown>> {
  return {
    inspect_cf_crash: async (args) => {
      const file = String(args.file ?? "");
      const inspected = inspectCfCrash(file);
      const anchor = buildRecencyAnchor([
        { name: "inspect_cf_crash", summary: "Inspect cfreplay capture" },
      ]);
      return {
        ...inspected,
        anchoredPreview: anchorPromptTail(inspected.summary, anchor),
      };
    },
    replay_cf_crash: async (args) => {
      const file = String(args.file ?? "");
      const entry = String(args.workerEntry ?? "default");
      const handler = handlerRegistry.get(entry);
      if (!handler) {
        throw new Error(`Unknown workerEntry: ${entry}. Register with registerReplayHandler().`);
      }
      const urlOptions: ReplayUrlOptions = {};
      if (args.unsafeReplayUrl === true) urlOptions.replayHost = false;
      else if (typeof args.replayHost === "string" && args.replayHost.length > 0) {
        urlOptions.replayHost = args.replayHost;
      }
      return replayCfCrash(file, handler, urlOptions);
    },
    export_vitest_regression: async (args) => {
      const file = String(args.file ?? "");
      const testName = args.testName ? String(args.testName) : "cf replay regression";
      const source = exportVitestRegression(file, testName);
      if (!allowWrite || dryRun) {
        return { dryRun: true, source };
      }
      const outPath = resolvePathUnderRoot(process.cwd(), `cfreplay-${Date.now()}.test.ts`);
      writeFileSync(outPath, source, "utf8");
      return { written: outPath, source };
    },
  };
}

export type McpServerOptions = {
  tools?: McpToolDef[];
  handlers?: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  pathToWsl?: boolean;
  nCtx?: number;
};

export function dispatchMcpMessage(
  msg: { jsonrpc?: string; id?: number | string; method?: string; params?: Record<string, unknown> },
  opts: McpServerOptions = {},
): void {
  const tools = opts.tools ?? FLAREDUMP_TOOLS;
  const handlers = opts.handlers ?? createFlareDumpHandlers();
  const toWsl = opts.pathToWsl ?? process.env.FLAREDUMP_PATH_WSL === "1";
  const nCtx = opts.nCtx ?? DEFAULT_N_CTX;
  handleMessage(msg, tools, handlers, toWsl, nCtx);
}

function handleMessage(
  msg: { id?: number | string; method?: string; params?: Record<string, unknown> },
  tools: McpToolDef[],
  handlers: Record<string, (args: Record<string, unknown>) => Promise<unknown>>,
  toWsl: boolean,
  nCtx: number,
): void {
  const { id, method, params } = msg;
  if (method === "initialize") {
    writeJsonRpcFrame({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "flaredump", version: "0.1.0" },
      },
    });
    return;
  }
  if (method === "notifications/initialized") return;
  if (method === "tools/list") {
    writeJsonRpcFrame({
      jsonrpc: "2.0",
      id,
      result: { tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations })) },
    });
    return;
  }
  if (method === "tools/call") {
    const name = params?.name as string;
    const args = normalizePathsDeep((params?.arguments as Record<string, unknown>) ?? {}, toWsl);
    const tool = tools.find((t) => t.name === name);
    const loopErr = checkLoopBreaker(name, args);
    if (loopErr) {
      writeJsonRpcFrame({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: loopErr }], isError: true } });
      return;
    }
    if (tool) {
      const guard = guardMutatingTool(tool);
      if (guard.blocked) {
        writeJsonRpcFrame({
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: guard.reason ?? "blocked" }], isError: true },
        });
        return;
      }
    }
    const handler = handlers[name];
    void (async () => {
      try {
        const result = await handler(args);
        const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
        writeJsonRpcFrame({
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: finalizeMcpToolText(text, { nCtx, toWsl }) }],
          },
        });
      } catch (e) {
        writeJsonRpcFrame({
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: finalizeMcpToolText(String(e), { nCtx, toWsl }) }],
            isError: true,
          },
        });
      }
    })();
    return;
  }
  if (id !== undefined) {
    writeJsonRpcFrame({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

export function startMcpServer(opts: McpServerOptions = {}): void {
  hijackStdoutForMcp();
  const stdin = process.stdin;
  stdin.setEncoding("utf8");
  let buffer = "";
  stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        dispatchMcpMessage(JSON.parse(line), opts);
      } catch {
        /* ignore */
      }
    }
  });
}

export const EMBED_LOCK = ".flaredump-embed-lock.json";
export type EmbedLock = { provider: string; model: string; dimension: number };

export function readEmbedLock(repoRoot: string): EmbedLock | null {
  const p = join(repoRoot, EMBED_LOCK);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as EmbedLock;
}

export function writeEmbedLock(repoRoot: string, lock: EmbedLock): void {
  writeFileSync(join(repoRoot, EMBED_LOCK), JSON.stringify(lock, null, 2));
}

export function assertDimensionFingerprint(lock: EmbedLock | null, dim: number): void {
  if (!lock) return;
  if (lock.dimension !== dim) {
    throw new Error(`Dimension fingerprint mismatch: lock expects ${lock.dimension}, got ${dim}`);
  }
}

export function l2Normalize(vec: number[]): number[] {
  let sum = 0;
  for (const v of vec) sum += v * v;
  const norm = Math.sqrt(sum) || 1;
  return vec.map((v) => v / norm);
}

export function mrlSlice(vec: number[], dimensions: number): number[] {
  return l2Normalize(vec.slice(0, dimensions));
}

export function floatArrayToBase64(vec: number[]): string {
  const buf = Buffer.alloc(vec.length * 4);
  for (let i = 0; i < vec.length; i++) buf.writeFloatLE(vec[i], i * 4);
  return buf.toString("base64");
}

export function base64ToFloatArray(b64: string): number[] {
  const buf = Buffer.from(b64, "base64");
  const out: number[] = [];
  for (let i = 0; i < buf.length; i += 4) out.push(buf.readFloatLE(i));
  return out;
}

export function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export async function normalizeEmbedBatch(
  inputs: string[],
  options: {
    dimensions?: number;
    upstream: { name: string; maxBatch: number; embed: (input: string[], model: string, dimensions?: number) => Promise<number[][]> };
    model: string;
    lock?: EmbedLock | null;
  },
): Promise<{ embeddings: number[][]; indices: number[] }> {
  const dimensions = options.dimensions;
  const indexed = inputs.map((text, i) => ({ text, i }));
  const nonEmpty = indexed.filter((x) => x.text.trim().length > 0);
  const batches = chunkArray(nonEmpty, options.upstream.maxBatch);
  const vectors = new Map<number, number[]>();
  for (const batch of batches) {
    const texts = batch.map((b) => b.text);
    const got = await options.upstream.embed(texts, options.model, dimensions);
    for (let j = 0; j < batch.length; j++) {
      let vec = got[j] ?? [];
      if (dimensions && vec.length > dimensions) vec = mrlSlice(vec, dimensions);
      else if (dimensions && vec.length === dimensions) vec = l2Normalize(vec);
      if (dimensions) assertDimensionFingerprint(options.lock ?? null, vec.length);
      vectors.set(batch[j].i, vec);
    }
  }
  const dim = dimensions ?? (vectors.values().next().value?.length ?? 0);
  const embeddings: number[][] = [];
  const indices: number[] = [];
  for (let i = 0; i < inputs.length; i++) {
    indices.push(i);
    embeddings.push(vectors.get(i) ?? new Array(dim).fill(0));
  }
  return { embeddings, indices };
}

export function stripRedactedThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?(?:<\/redacted_thinking>|$)/gi, "");
}

function repairJson(raw: string): string {
  let s = raw.trim();
  s = s.replace(/,\s*([}\]])/g, "$1");
  s = s.replace(/'/g, '"');
  const open = (s.match(/\{/g) ?? []).length;
  const close = (s.match(/\}/g) ?? []).length;
  if (open > close) s += "}".repeat(open - close);
  return s;
}

function tryParseObject(raw: string): Record<string, unknown> | null {
  for (const a of [raw, repairJson(raw)]) {
    try {
      const v = JSON.parse(a);
      if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      /* next */
    }
  }
  return null;
}

export function parseDirtyToolCall(content: string): { name: string; arguments: Record<string, unknown> } | null {
  const text = stripRedactedThinking(content);
  const fnDot = text.match(/functions\.([a-zA-Z0-9_]+):\d+/);
  if (fnDot) {
    const jsonMatch = text.match(/\{[\s\S]*?\}/);
    if (jsonMatch) {
      const obj = tryParseObject(jsonMatch[0]);
      if (obj) return { name: fnDot[1], arguments: obj };
    }
  }
  const hermes = text.match(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/i);
  if (hermes) {
    const obj = tryParseObject(hermes[1]);
    if (obj?.name && typeof obj.name === "string") {
      return { name: obj.name, arguments: (obj.arguments as Record<string, unknown>) ?? {} };
    }
  }
  const kimi = text.match(
    /functions\.([a-zA-Z0-9_]+):\d+<\|[^>]+\|>(\{[\s\S]*?\})<\|[^>]+\|>/i,
  );
  if (kimi) {
    const obj = tryParseObject(kimi[2]);
    return { name: kimi[1].trim(), arguments: obj ?? {} };
  }
  const glm = text.match(
    /<\|(?:redacted_)?tool_call_begin(?:_kimi)?\|>([^<\|]+)<\|tool_call_sep\|>([\s\S]*?)<\|(?:redacted_)?tool_call_end(?:_kimi)?\|>/i,
  );
  if (glm) {
    const obj = tryParseObject(glm[2]);
    return { name: glm[1].trim(), arguments: obj ?? {} };
  }
  const qwenFn = text.match(/✿FUNCTION✿:\s*([^\n]+)\s*✿ARGS✿:\s*([\s\S]*?)(?:✿RESULT✿|$)/i);
  if (qwenFn) {
    const obj = tryParseObject(qwenFn[2]);
    return { name: qwenFn[1].trim(), arguments: obj ?? {} };
  }
  const iqBroken = tryParseObject(text);
  if (iqBroken?.cmd) return { name: "run_shell", arguments: iqBroken };
  return null;
}

export class StreamToolJsonAbort {
  private depth = 0;
  private started = false;
  private acc = "";

  feed(chunk: string): boolean {
    this.acc += chunk;
    if (!this.started && /<tool_call>/i.test(this.acc)) this.started = true;
    this.depth = braceDepth(this.acc);
    return this.started && this.depth === 0 && /\{[\s\S]*\}/.test(this.acc);
  }
}

function braceDepth(text: string): number {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (const c of text) {
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (c === "\\") escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") depth--;
  }
  return depth;
}

export type ChatMessage = {
  role: string;
  content?: string | null;
  tool_calls?: unknown[];
  reasoning_content?: string;
};

export type ReasoningState = { inToolLoop: boolean; lastUserTurnIndex: number };

export function createReasoningState(): ReasoningState {
  return { inToolLoop: false, lastUserTurnIndex: -1 };
}

export function applyReasoningContentPolicy(
  messages: ChatMessage[],
  state: ReasoningState,
): { messages: ChatMessage[]; state: ReasoningState } {
  let lastUser = -1;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "user") lastUser = i;
  }
  const newUserTurn = lastUser > state.lastUserTurnIndex;
  if (newUserTurn) state = { ...state, lastUserTurnIndex: lastUser, inToolLoop: false };
  const hasPendingTools = messages.some((m) => m.role === "assistant" && m.tool_calls?.length);
  if (hasPendingTools) state = { ...state, inToolLoop: true };
  const cleaned = messages.map((m, idx) => {
    const copy = { ...m };
    if (copy.content && typeof copy.content === "string") copy.content = stripRedactedThinking(copy.content);
    if (newUserTurn && copy.role === "assistant" && idx < lastUser) delete copy.reasoning_content;
    if (!state.inToolLoop && copy.role === "assistant") delete copy.reasoning_content;
    return copy;
  });
  return { messages: cleaned, state };
}

export function detectProvider(baseUrl: string): string {
  const u = baseUrl.toLowerCase();
  if (u.includes("dashscope")) return "dashscope";
  if (u.includes("ollama") || u.includes("11434")) return "ollama";
  return "generic";
}

export function sanitizeRequestBody(body: Record<string, unknown>, model: string): Record<string, unknown> {
  const out = { ...body };
  if (/reasoner|qwq|thinking/i.test(model)) {
    delete out.temperature;
    delete out.top_p;
  }
  return out;
}

export function normalizeToolChoice(toolChoice: unknown, provider: string): unknown {
  if (toolChoice === "required" && provider === "dashscope") return "auto";
  return toolChoice;
}

export type ExplainOptions = {
  model?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
};

export async function explainCrashWithModel(file: string, options: ExplainOptions = {}): Promise<string> {
  const inspected = inspectCfCrash(file);
  const model = options.model ?? "llama3.2";
  const baseUrl = (options.baseUrl ?? "http://127.0.0.1:11434").replace(/\/$/, "");
  const provider = detectProvider(baseUrl);
  const body = sanitizeRequestBody(
    {
      model: model.replace(/^ollama\//, ""),
      messages: [
        { role: "user", content: `Explain this Worker crash:\n${inspected.summary}` },
      ],
      stream: false,
    },
    model,
  );
  const fetchImpl = options.fetchImpl ?? fetch;
  const path = provider === "ollama" ? "/api/chat" : "/v1/chat/completions";
  const res = await fetchImpl(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Explain request failed: ${res.status}`);
  const json = (await res.json()) as {
    message?: { content?: string };
    choices?: Array<{ message?: { content?: string } }>;
  };
  return json.message?.content ?? json.choices?.[0]?.message?.content ?? JSON.stringify(json);
}
