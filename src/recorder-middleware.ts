import { scrubDeep } from "./scrubber.js";

/** Configuration and data shape for `BindingKind` (binding kind). */
export type BindingKind = "d1" | "kv" | "ai";

/** Configuration and data shape for `BindingRecord` (binding record). */
export type BindingRecord = {
  kind: BindingKind;
  binding: string;
  op: string;
  args: unknown;
  result: unknown;
};

/** Configuration and data shape for `CfReplayRequest` (cf replay request). */
export type CfReplayRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
};

/** Configuration and data shape for `CfReplayFile` (cf replay file). */
export type CfReplayFile = {
  version: 1;
  capturedAt: string;
  request: CfReplayRequest;
  bindings: BindingRecord[];
  passthroughEnv?: Record<string, unknown>;
  error?: { message: string; stack?: string };
  responseStatus?: number;
};

/** Configuration and data shape for `WorkerHandler` (worker handler). */
export type WorkerHandler = (
  request: Request,
  env: Record<string, unknown>,
  ctx?: { waitUntil: (p: Promise<unknown>) => void },
) => Promise<Response> | Response;

/** Configuration and data shape for `FlareDumpOptions` (flare dump options). */
export type FlareDumpOptions = {
  onCapture?: (replay: CfReplayFile) => void;
};

function headersToObject(req: Request): Record<string, string> {
  const h: Record<string, string> = {};
  req.headers.forEach((v, k) => {
    h[k] = v;
  });
  return h;
}

type D1Stmt = {
  bind?: (...params: unknown[]) => D1Stmt;
  all?: () => Promise<unknown>;
  first?: () => Promise<unknown>;
  run?: () => Promise<unknown>;
};

function wrapD1(binding: string, db: { prepare: (sql: string) => D1Stmt }, log: BindingRecord[]): unknown {
  return {
    prepare: (sql: string) => {
      const base = db.prepare(sql);
      const record = async (op: string, args: unknown, runner: () => Promise<unknown>) => {
        const result = await runner();
        log.push({ kind: "d1", binding, op, args, result });
        return result;
      };
      const chain = (bound?: unknown[]) => ({
        all: () =>
          record(
            bound ? "prepare.bind.all" : "prepare.all",
            bound ? { sql, params: bound } : { sql },
            () => (bound ? base.bind!(...bound).all!() : base.all!()),
          ),
        first: () =>
          record(
            bound ? "prepare.bind.first" : "prepare.first",
            bound ? { sql, params: bound } : { sql },
            () => (bound ? base.bind!(...bound).first!() : base.first!()),
          ),
        run: () =>
          record(
            bound ? "prepare.bind.run" : "prepare.run",
            bound ? { sql, params: bound } : { sql },
            () => (bound ? base.bind!(...bound).run!() : base.run!()),
          ),
      });
      return {
        bind: (...params: unknown[]) => chain(params),
        all: () => chain().all(),
        first: () => chain().first(),
        run: () => chain().run(),
      };
    },
  };
}

function wrapKv(binding: string, kv: Record<string, unknown>, log: BindingRecord[]): unknown {
  const wrap = (op: string) => async (...args: unknown[]) => {
    const fn = kv[op] as (...a: unknown[]) => Promise<unknown>;
    const result = await fn(...args);
    log.push({ kind: "kv", binding, op, args, result });
    return result;
  };
  return {
    get: wrap("get"),
    put: wrap("put"),
    delete: wrap("delete"),
    list: wrap("list"),
  };
}

function wrapAi(binding: string, ai: { run: (model: string, input: unknown) => Promise<unknown> }, log: BindingRecord[]): unknown {
  return {
    run: async (model: string, input: unknown) => {
      const result = await ai.run(model, input);
      log.push({ kind: "ai", binding, op: "run", args: { model, input }, result });
      return result;
    },
  };
}

function isInstrumentedBinding(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if ("prepare" in value) return true;
  if ("get" in value && "put" in value) return true;
  if ("run" in value) return true;
  return false;
}

function snapshotPassthroughEnv(env: Record<string, unknown>): Record<string, unknown> {
  const snap: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(env)) {
    if (isInstrumentedBinding(value)) continue;
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      snap[key] = value;
    }
  }
  return scrubDeep(snap);
}

function instrumentEnv(env: Record<string, unknown>, log: BindingRecord[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value && typeof value === "object" && "prepare" in value) {
      out[key] = wrapD1(key, value as { prepare: (sql: string) => D1Stmt }, log);
    } else if (value && typeof value === "object" && "get" in value && "put" in value) {
      out[key] = wrapKv(key, value as Record<string, unknown>, log);
    } else if (value && typeof value === "object" && "run" in value) {
      out[key] = wrapAi(key, value as { run: (m: string, i: unknown) => Promise<unknown> }, log);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Executes `readRequestBody` to read request body in `flaredump`. */
export async function readRequestBody(request: Request): Promise<string | undefined> {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  try {
    const text = await request.clone().text();
    return text.length ? text : undefined;
  } catch {
    return undefined;
  }
}

async function captureReplay(
  request: Request,
  log: BindingRecord[],
  err: unknown,
  env: Record<string, unknown>,
  responseStatus?: number,
): Promise<CfReplayFile> {
  const body = await readRequestBody(request);
  const passthroughEnv = snapshotPassthroughEnv(env);
  return scrubDeep({
    version: 1,
    capturedAt: new Date().toISOString(),
    request: {
      method: request.method,
      url: request.url,
      headers: headersToObject(request),
      body,
    },
    bindings: log,
    passthroughEnv: Object.keys(passthroughEnv).length > 0 ? passthroughEnv : undefined,
    error: err instanceof Error
      ? { message: err.message, stack: err.stack }
      : { message: String(err) },
    responseStatus,
  }) as CfReplayFile;
}

/** Executes `withFlareDump` to with flare dump in `flaredump`. */
export function withFlareDump(handler: WorkerHandler, options: FlareDumpOptions = {}): WorkerHandler {
  return async (request, env, ctx) => {
    const log: BindingRecord[] = [];
    const wrappedEnv = instrumentEnv(env, log);
    try {
      const response = await handler(request, wrappedEnv, ctx);
      if (response.status >= 500) {
        options.onCapture?.(await captureReplay(request, log, `HTTP ${response.status}`, env, response.status));
      }
      return response;
    } catch (err) {
      options.onCapture?.(await captureReplay(request, log, err, env));
      throw err;
    }
  };
}

/** Executes `serializeReplay` to serialize replay in `flaredump`. */
export function serializeReplay(replay: CfReplayFile): string {
  return JSON.stringify(scrubDeep(replay), null, 2);
}
