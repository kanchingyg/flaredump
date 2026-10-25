import { readFileSync } from "node:fs";
import { basename } from "node:path";

import type { BindingRecord, CfReplayFile, WorkerHandler } from "./recorder-middleware.js";
import { resolveReplayFilePath } from "./replay-path.js";

export { setReplayRoot, getReplayRoot } from "./replay-path.js";

export const DEFAULT_REPLAY_HOST = "replay.local";

export type ReplayUrlOptions = {
  replayHost?: string | false;
};

export function safeReplayRequestUrl(capturedUrl: string, options: ReplayUrlOptions = {}): string {
  const host = options.replayHost === undefined ? DEFAULT_REPLAY_HOST : options.replayHost;
  if (host === false) return capturedUrl;
  try {
    const u = new URL(capturedUrl);
    return `https://${host}${u.pathname}${u.search}${u.hash}`;
  } catch {
    return `https://${host}/`;
  }
}

export const DEFAULT_N_CTX = 4096;
const TRUNC_MARKER = "[...TRUNCATED BY FLAREDUMP CONTEXT GUARD...]";

export function headTailTruncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const headLen = Math.floor(maxChars * 0.6);
  const tailLen = Math.floor(maxChars * 0.4) - TRUNC_MARKER.length;
  if (tailLen < 0) return text.slice(0, maxChars);
  return text.slice(0, headLen) + TRUNC_MARKER + text.slice(-tailLen);
}

export function loadReplayFile(filePath: string): CfReplayFile {
  const abs = resolveReplayFilePath(filePath);
  const raw = readFileSync(abs, "utf8");
  const parsed = JSON.parse(raw) as CfReplayFile;
  if (parsed.version !== 1) {
    throw new Error(`Unsupported cfreplay version: ${String((parsed as { version?: unknown }).version)}`);
  }
  return parsed;
}

export function buildMockEnvFromBindings(replay: CfReplayFile | BindingRecord[]): Record<string, unknown> {
  const bindings = Array.isArray(replay) ? replay : replay.bindings;
  const env: Record<string, unknown> = {};
  if (!Array.isArray(replay) && replay.passthroughEnv) {
    Object.assign(env, replay.passthroughEnv);
  }

  const findD1 = (binding: string, sql: string, params?: unknown[]) => {
    return bindings.find((b) => {
      if (b.kind !== "d1" || b.binding !== binding) return false;
      const args = b.args as { sql?: string; params?: unknown[] };
      if (args.sql !== sql) return false;
      if (params) {
        return JSON.stringify(args.params) === JSON.stringify(params);
      }
      return !args.params;
    });
  };

  const d1Names = [...new Set(bindings.filter((b) => b.kind === "d1").map((b) => b.binding))];
  for (const name of d1Names) {
    env[name] = {
      prepare: (sql: string) => ({
        bind: (...params: unknown[]) => ({
          all: async () => findD1(name, sql, params)?.result ?? { results: [] },
          first: async () => findD1(name, sql, params)?.result ?? null,
          run: async () => ({ success: true }),
        }),
        all: async () => findD1(name, sql)?.result ?? { results: [] },
        first: async () => findD1(name, sql)?.result ?? null,
        run: async () => ({ success: true }),
      }),
    };
  }

  const kvNames = [...new Set(bindings.filter((b) => b.kind === "kv").map((b) => b.binding))];
  for (const name of kvNames) {
    env[name] = {
      get: async (key: string) => {
        const hit = bindings.find((b) => {
          if (b.kind !== "kv" || b.binding !== name || b.op !== "get") return false;
          const args = b.args as unknown[];
          return args[0] === key;
        });
        return hit?.result ?? null;
      },
      put: async () => undefined,
      delete: async () => undefined,
      list: async () => ({ keys: [] }),
    };
  }

  const aiNames = [...new Set(bindings.filter((b) => b.kind === "ai").map((b) => b.binding))];
  for (const name of aiNames) {
    env[name] = {
      run: async (model: string, input: unknown) => {
        const hit = bindings.find(
          (b) =>
            b.kind === "ai" &&
            b.binding === name &&
            (b.args as { model?: string }).model === model,
        );
        return hit?.result ?? {};
      },
    };
  }

  return env;
}

export type InspectResult = {
  request: CfReplayFile["request"];
  error?: CfReplayFile["error"];
  bindings: BindingRecord[];
  d1Queries: Array<{ binding: string; sql: string; params?: unknown[] }>;
  summary: string;
};

export function inspectCfCrash(file: string, nCtx = DEFAULT_N_CTX): InspectResult {
  const replay = loadReplayFile(file);
  const d1Queries = replay.bindings
    .filter((b) => b.kind === "d1")
    .map((b) => {
      const args = b.args as { sql?: string; params?: unknown[] };
      return { binding: b.binding, sql: args.sql ?? "", params: args.params };
    });
  const payload = JSON.stringify(
    { request: replay.request, error: replay.error, d1Queries, bindings: replay.bindings },
    null,
    2,
  );
  const budget = Math.max(400, Math.floor(nCtx * 4 * 0.25));
  return {
    request: replay.request,
    error: replay.error,
    bindings: replay.bindings,
    d1Queries,
    summary: headTailTruncate(payload, budget),
  };
}

export type ReplayResult = {
  status: number;
  body: string;
  threw: boolean;
  errorMessage?: string;
};

export async function replayCfCrash(
  file: string,
  handler: WorkerHandler,
  urlOptions: ReplayUrlOptions = {},
): Promise<ReplayResult> {
  const replay = loadReplayFile(file);
  const env = buildMockEnvFromBindings(replay);
  const init: RequestInit = {
    method: replay.request.method,
    headers: replay.request.headers,
  };
  if (replay.request.body !== undefined) {
    init.body = replay.request.body;
  }
  const req = new Request(safeReplayRequestUrl(replay.request.url, urlOptions), init);
  try {
    const res = await handler(req, env);
    const body = await res.text();
    return { status: res.status, body, threw: false };
  } catch (e) {
    return {
      status: 500,
      body: "",
      threw: true,
      errorMessage: e instanceof Error ? e.message : String(e),
    };
  }
}

export function exportVitestRegression(file: string, testName = "cf replay regression"): string {
  const replay = loadReplayFile(file);
  const safeName = testName.replace(/[^a-zA-Z0-9_]/g, "_");
  const replayFile = `./${basename(file)}`;
  return `import { describe, it, expect } from "vitest";
import { replayCfCrash } from "flaredump";
import handler from "./worker";

describe("${safeName}", () => {
  it("replays captured crash", async () => {
    const result = await replayCfCrash("${replayFile}", handler);
    expect(result.threw).toBe(${replay.error ? "true" : "false"});
    ${
      replay.error
        ? `expect(result.errorMessage).toContain(${JSON.stringify(replay.error.message.slice(0, 24))});`
        : `expect(result.status).toBe(${replay.responseStatus ?? 500});`
    }
  });
});
`;
}
